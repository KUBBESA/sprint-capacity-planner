// planner-core.mjs — lógica compartida entre el proxy Node local y el handler Lambda (AWS).
// No depende de node:http ni de config.json; toda conexión a Jira pasa por la factory createJiraApi.

const JIRA_IMPORT_EXCLUDE = new Set(['Epic', 'Sub-task', 'Test', 'Test Case', 'Test Execution', 'Spike']);
const CARRYOVER_STATUSES = new Set([
  'In Progress', 'Ready for QA', 'QA', 'QA DEV', 'QA/STG', 'En revisión',
  'En curso', 'Testing OK', 'Ready for Prod', 'STG', 'Dev', 'Desarrollo',
]);

const JIRA_STORY_FIELDS = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'resolution', 'customfield_10195', 'customfield_10196'];

export const STORY_DEV_FIELD = 'customfield_10195';
export const STORY_QA_FIELD = 'customfield_10196';

const DEV_ROLES = /dev(eloper)?|desarrollo|ingenier/i;
const QA_ROLES = /qa|test|calidad|asegur/i;

export function jiraPriority(name) {
  const p = String(name || 'medium').toLowerCase();
  if (['highest', 'high', 'urgent', 'blocker', 'critical', 's1', 's2'].includes(p)) return 'alta';
  if (['low', 'lowest', 'low', 'trivial', 'minor'].includes(p)) return 'baja';
  return 'media';
}

export function parseHours(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'tbd') return null;
  }
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

export function hoursToJira(v) {
  if (v === null || v === undefined) return undefined;
  if (v === '') return ''; // limpiar el campo en Jira
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return String(n);
}

export function buildStoryFields(dev, qa) {
  const fields = {};
  const devS = hoursToJira(dev);
  const qaS = hoursToJira(qa);
  if (devS !== undefined) fields[STORY_DEV_FIELD] = devS;
  if (qaS !== undefined) fields[STORY_QA_FIELD] = qaS;
  return fields;
}

export function requiredAsTbd(fields) {
  const out = {};
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === '') { out[k] = 'tbd'; changed = true; }
    else out[k] = v;
  }
  return changed ? out : null;
}

/**
 * Personal Data Reporting API (GDPR): inventario y borrado de datos personales.
 * El dato personal que guardamos es: accountId + displayName (updatedBy de cada
 * sesión, miembros devPeople/qaPeople, y assignee de las stories).
 */

/** Devuelve [{accountId, displayName}] únicos con referencias personales de todas las sesiones. */
export function collectAccountReferences(sessions) {
  const map = new Map();
  const add = (id, name) => {
    if (id && id !== 'unknown') {
      const cur = map.get(id) || '';
      if (!cur && name) map.set(id, name);
    }
  };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s.updatedBy) add(s.updatedBy.accountId, s.updatedBy.displayName);
    const d = s.data || {};
    for (const m of [...(d.devPeople || []), ...(d.qaPeople || [])]) add(m.accountId, m.name);
    for (const st of d.stories || []) add(st.assigneeAccountId, st.assignee);
  }
  return [...map.entries()].map(([accountId, displayName]) => ({ accountId, displayName }));
}

/** Quita toda referencia personal a `accountId` de las sesiones (purga GDPR). Devuelve {sessions, changed}. */
export function scrubSessions(sessions, accountId) {
  const clean = s => {
    let changed = false;
    const out = { ...s };
    if (out.updatedBy && out.updatedBy.accountId === accountId) { out.updatedBy = null; changed = true; }
    const d = out.data ? { ...out.data } : null;
    if (d) {
      if (Array.isArray(d.devPeople) && d.devPeople.some(m => m.accountId === accountId)) {
        d.devPeople = d.devPeople.filter(m => m.accountId !== accountId); changed = true;
      }
      if (Array.isArray(d.qaPeople) && d.qaPeople.some(m => m.accountId === accountId)) {
        d.qaPeople = d.qaPeople.filter(m => m.accountId !== accountId); changed = true;
      }
      if (Array.isArray(d.stories)) {
        const next = d.stories.map(st => st.assigneeAccountId === accountId ? { ...st, assignee: '', assigneeAccountId: '' } : st);
        if (next.some((st, i) => st !== d.stories[i])) { d.stories = next; changed = true; }
      }
    }
    if (changed) out.data = d;
    return { s: out, changed };
  };
  let any = false;
  const next = sessions.map(s => { const r = clean(s); if (r.changed) any = true; return r.s; });
  return { sessions: next, changed: any };
}

/**
 * Factory de API de Jira. `baseUrl` es el origen (sin slash final):
 *  - local: 'https://team-crediviva.atlassian.net'
 *  - lambda: 'https://api.atlassian.com/ex/jira/<cloudId>'
 * `headers()` devuelve los headers de autenticación (Basic/PAT o Bearer por usuario).
 */
export function createJiraApi({ baseUrl, headers }) {
  const hdrs = () => ({ ...headers(), Accept: 'application/json' });

  async function raw(path, { method = 'GET', body } = {}) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { ...hdrs(), 'Content-Type': 'application/json' } : hdrs(),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function jiraJson(path, opts) {
    const res = await raw(path, opts);
    if (!res.ok) throw new Error(`Jira ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async function jiraMembers(projectKey) {
    const data = await jiraJson(`/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`);
    return (data || [])
      .map(u => ({ accountId: u.accountId || '', displayName: u.displayName || u.name || u.emailAddress || '', email: u.emailAddress || '', active: u.active !== false }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async function teamMembers(projectKey) {
    const roles = await jiraJson(`/rest/api/3/project/${encodeURIComponent(projectKey)}/role`);
    const devs = new Set();
    const qas = new Set();
    const others = new Set();
    for (const [roleName, roleUrl] of Object.entries(roles)) {
      let role;
      try { role = await jiraJson(roleUrl); }
      catch (e) { console.warn(`No se pudo leer rol "${roleName}": ${e.message}`); continue; }
      const isDev = DEV_ROLES.test(roleName);
      const isQa = QA_ROLES.test(roleName);
      for (const actor of (role.actors || [])) {
        const name = actor.displayName || actor.name;
        if (!name) continue;
        if (isDev) devs.add(name);
        else if (isQa) qas.add(name);
        else others.add(name);
      }
    }
    return { devs: [...devs].sort(), qas: [...qas].sort(), others: [...others].sort(), all: [...new Set([...devs, ...qas, ...others])].sort() };
  }

  async function jiraSprints(boardId) {
    const out = [];
    let startAt = 0;
    const page = 100;
    for (;;) {
      const data = await jiraJson(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=${page}&startAt=${startAt}`);
      const vals = data.values || [];
      out.push(...vals.map(sp => ({ id: sp.id, name: sp.name || `Sprint ${sp.id}`, state: sp.state, startDate: sp.startDate || '', endDate: sp.endDate || '', goal: sp.goal || '' })));
      if (!vals.length || out.length >= (data.total || 0)) break;
      startAt += vals.length;
      if (vals.length < page) break;
    }
    return out;
  }

  async function jiraSearch(jql) {
    const out = [];
    const maxResults = 100;
    let nextPageToken;
    for (;;) {
      const body = { jql, fields: JIRA_STORY_FIELDS, maxResults };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const res = await raw('/rest/api/3/search/jql', { method: 'POST', body });
      if (!res.ok) throw new Error(`Jira ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const issues = data.issues || [];
      out.push(...issues);
      if (data.isLast === true || data.isLast === undefined || !issues.length) break;
      if (!data.nextPageToken) break;
      nextPageToken = data.nextPageToken;
    }
    return out;
  }

  async function jiraStories(boardId, projectKey, sprintOrBacklog) {
    const jql = sprintOrBacklog === 'backlog'
      ? `project = ${projectKey} AND Sprint IS EMPTY ORDER BY Rank ASC`
      : `project = ${projectKey} AND Sprint = ${Number(sprintOrBacklog)} ORDER BY Rank ASC`;
    const issues = await jiraSearch(jql);
    const stories = [];
    for (const it of issues) {
      const f = it.fields || {};
      const type = (f.issuetype && f.issuetype.name) || '';
      if (!type || JIRA_IMPORT_EXCLUDE.has(type)) continue;
      if (f.resolution && f.resolution.name) continue;
      const status = (f.status && f.status.name) || '';
      stories.push({
        id: it.key,
        title: f.summary || it.key,
        priority: jiraPriority(f.priority && f.priority.name),
        status,
        carryOver: CARRYOVER_STATUSES.has(status),
        dev: parseHours(f.customfield_10195),
        qa: parseHours(f.customfield_10196),
        forcedDev: 'auto',
        forcedQa: 'auto',
        assignee: (f.assignee && (f.assignee.displayName || f.assignee.name)) || '',
        assigneeAccountId: (f.assignee && f.assignee.accountId) || '',
      });
    }
    return stories;
  }

  /** Escribe horas DEV/QA; si Jira exige el campo (required), reintenta con "tbd". */
  async function updateStoryHours(key, fields) {
    const put = async (f) => {
      const r = await raw(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields: f } });
      return { r, text: () => r.text() };
    };
    const { r, text } = await put(fields);
    if (r.ok) return { fields };
    const errText = await text();
    const hasEmpty = Object.values(fields).some(v => v === '');
    if (hasEmpty && /required/i.test(errText)) {
      const retry = requiredAsTbd(fields);
      const { r: r2, text: text2 } = await put(retry);
      if (r2.ok) return { fields: retry, note: 'Campo obligatorio en Jira: se escribió "tbd" (no planificado) en vez de vacío' };
      throw new Error(`Jira ${r2.status} ${r2.statusText}: ${(await text2()).slice(0, 300)}`);
    }
    throw new Error(`Jira ${r.status} ${r.statusText}: ${errText.slice(0, 300)}`);
  }

  return { raw, jiraJson, jiraMembers, teamMembers, jiraSprints, jiraSearch, jiraStories, updateStoryHours };
}