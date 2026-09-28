// lambda/handler.mjs — backend sin servidor del Sprint Capacity Planner.
// API Gateway HTTP API (payload v2). Sirve:
//  - /auth/*: OAuth 2.0 (3LO) con Atlassian, sesiones por cookie HttpOnly.
//  - /jira/*:  llamadas a Jira con el token del usuario logueado (Bearer).
//  - /planner/sessions: sesiones del plan compartidas por el equipo (DynamoDB + optimistic concurrency).
import { randomUUID } from 'node:crypto';

// planner-core.mjs vive en /opt (capa Lambda) y, para test local, en la raiz del proyecto.
let plannerCore = null;
try { plannerCore = await import('/opt/planner-core.mjs'); }
catch (_e) { plannerCore = await import('../planner-core.mjs'); }
const { createJiraApi, jiraPriority, parseHours, hoursToJira, buildStoryFields, requiredAsTbd, collectAccountReferences, scrubSessions, STORY_DEV_FIELD, STORY_QA_FIELD } = plannerCore;

const SITE_URL = (process.env.SITE_URL || 'https://team-crediviva.atlassian.net').replace(/\/+$/, '');
const APP_ORIGIN = (process.env.APP_ORIGIN || 'https://sprint.crediviva.com.pa').replace(/\/+$/, '');
const REDIRECT_URI = (process.env.REDIRECT_URI || `${APP_ORIGIN}/auth/callback`); // exacta según la app OAuth registrada
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ''; // p.ej. '.crediviva.com.pa' en produccion, '' en dev
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || '';
const PLANNER_TABLE = process.env.PLANNER_TABLE || '';
const PERSONAL_DATA_TABLE = process.env.PERSONAL_DATA_TABLE || '';
const SCOPES = 'read:jira-user read:jira-work write:jira-work offline_access';
const AUTH_URL = 'https://auth.atlassian.com';
const API_URL = 'https://api.atlassian.com';
const REPORT_URL = `${API_URL}/app/report-accounts/`;
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const STATE_MAX_AGE = 60 * 10;
const SESSION_COOKIE = 'scp_session';
const STATE_COOKIE = 'scp_state';

// ---- DynamoDB (disponible en el runtime Lambda; fallback en memoria para sam local) ---------
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const memSessions = new Map(); // sam local / sin tabla
const memPersonal = new Map(); // registro personal-data en memoria

async function plannerGet() {
  if (!PLANNER_TABLE) {
    const it = memSessions.get('shared');
    return { itemUpdatedAt: it ? it.itemUpdatedAt : null, sessions: it ? (JSON.parse(it.sessionsJson || 'null') || []) : null };
  }
  const res = await ddbDoc.send(new GetCommand({ TableName: PLANNER_TABLE, Key: { pk: 'shared' } }));
  const it = res.Item;
  if (!it) return { itemUpdatedAt: null, sessions: null };
  return { itemUpdatedAt: it.itemUpdatedAt, sessions: JSON.parse(it.sessionsJson || 'null') };
}
async function plannerPut(sessions, baseUpdatedAt) {
  const now = Date.now();
  const item = { pk: 'shared', itemUpdatedAt: now, sessionsJson: JSON.stringify(sessions) };
  if (PLANNER_TABLE) {
    try {
      await ddbDoc.send(new PutCommand({
        TableName: PLANNER_TABLE,
        Item: item,
        ConditionExpression: '#up = :base OR attribute_not_exists(#up)',
        ExpressionAttributeNames: { '#up': 'itemUpdatedAt' },
        ExpressionAttributeValues: baseUpdatedAt ? { ':base': baseUpdatedAt } : { ':base': 0 },
      }));
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        const cur = await plannerGet();
        throw Object.assign(new Error('Conflicto: alguien actualizó la sesión mientras editabas'), { status: 409, current: cur });
      }
      throw e;
    }
  } else {
    if (baseUpdatedAt && memSessions.get('shared') && memSessions.get('shared').itemUpdatedAt !== baseUpdatedAt) {
      throw Object.assign(new Error('Conflicto'), { status: 409, current: await plannerGet() });
    }
    memSessions.set('shared', item);
  }
  return { ok: true, itemUpdatedAt: now, sessions };
}
async function plannerDelete(id) {
  const cur = await plannerGet();
  const arr = Array.isArray(cur.sessions) ? cur.sessions.filter(s => s.id !== id) : [];
  const now = Date.now();
  if (PLANNER_TABLE) {
    await ddbDoc.send(new PutCommand({
      TableName: PLANNER_TABLE,
      Item: { pk: 'shared', itemUpdatedAt: now, sessionsJson: JSON.stringify(arr) },
    }));
  } else memSessions.set('shared', { itemUpdatedAt: now, sessionsJson: JSON.stringify(arr) });
  return { ok: true };
}

// ---- Personal Data Reporting API (GDPR) -----------------------------------------------------
// Registro de accountIds cuyo dato personal guardamos; report a Atlassian cada ~7 dias; borrado
// cuando Atlassian responde status "closed". Ver user-privacy-developer-guide de Jira Cloud.
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
async function personalScan() {
  if (!PERSONAL_DATA_TABLE) return [...memPersonal.values()];
  const out = [];
  let token;
  do {
    const r = await ddbDoc.send(new ScanCommand({ TableName: PERSONAL_DATA_TABLE, ExclusiveStartKey: token }));
    out.push(...(r.Items || []));
    token = r.LastEvaluatedKey;
  } while (token);
  return out;
}
async function personalPut(accountId) {
  const item = { accountId, updatedAt: new Date().toISOString() };
  if (!PERSONAL_DATA_TABLE) { memPersonal.set(accountId, item); return; }
  await ddbDoc.send(new PutCommand({ TableName: PERSONAL_DATA_TABLE, Item: item }));
}
async function personalDelete(accountId) {
  if (!PERSONAL_DATA_TABLE) { memPersonal.delete(accountId); return; }
  await ddbDoc.send(new DeleteCommand({ TableName: PERSONAL_DATA_TABLE, Key: { accountId } }));
}
async function personalTouchSessions(sessions) {
  for (const ref of collectAccountReferences(sessions)) await personalPut(ref.accountId);
}
async function sessionScanByAccount(accountId) {
  if (!SESSIONS_TABLE) return [...memSessions.values()].filter(s => s.accountId === accountId);
  const out = [];
  let token;
  do {
    const r = await ddbDoc.send(new ScanCommand({
      TableName: SESSIONS_TABLE,
      FilterExpression: 'accountId = :a',
      ExpressionAttributeValues: { ':a': accountId },
      ExclusiveStartKey: token,
    }));
    out.push(...(r.Items || []));
    token = r.LastEvaluatedKey;
  } while (token);
  return out;
}
async function allSessions() {
  if (!SESSIONS_TABLE) return [...memSessions.values()];
  const out = [];
  let token;
  do {
    const r = await ddbDoc.send(new ScanCommand({ TableName: SESSIONS_TABLE, ExclusiveStartKey: token }));
    out.push(...(r.Items || []));
    token = r.LastEvaluatedKey;
  } while (token);
  return out;
}
async function erasePersonalData(accountId) {
  for (const s of await sessionScanByAccount(accountId)) if (s.sessionId) await sessionDelete(s.sessionId);
  const cur = await plannerGet();
  const arr = Array.isArray(cur.sessions) ? cur.sessions : [];
  const { sessions, changed } = scrubSessions(arr, accountId);
  if (changed) {
    const now = Date.now();
    const item = { pk: 'shared', itemUpdatedAt: now, sessionsJson: JSON.stringify(sessions) };
    if (PLANNER_TABLE) await ddbDoc.send(new PutCommand({ TableName: PLANNER_TABLE, Item: item }));
    else memSessions.set('shared', item);
  }
  await personalDelete(accountId);
  return { changed };
}
async function pickBearerSession() {
  for (const s of await allSessions()) {
    if (!s || !s.access) continue;
    try { return await ensureToken(s); } catch (e) { /* token revocado, probar otro */ }
  }
  return null;
}
async function runPrivacyReporter() {
  const register = await personalScan();
  const accounts = register.filter(r => r.accountId && r.accountId !== 'unknown');
  if (!accounts.length) return { ok: true, reported: 0, erased: [], note: 'sin datos personales registrados' };
  const bearer = await pickBearerSession();
  if (!bearer) return { ok: true, reported: accounts.length, erased: [], note: 'sin token 3LO válido; reintente el próximo ciclo' };
  const erased = [];
  const cycle = new Date().toISOString();
  let cyclePeriod = null;
  for (const batch of chunk(accounts, 90)) {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer.access}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accounts: batch.map(a => ({ accountId: a.accountId, updatedAt: a.updatedAt || cycle })) }),
    });
    const cp = res.headers.get('Cycle-Period');
    if (cp) cyclePeriod = cp;
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') || 60);
      const text = (await res.text()).slice(0, 200);
      throw new Error(`report-accounts rate-limited (retry-after ${retry}s): ${text}`);
    }
    if (!res.ok) throw new Error(`report-accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (res.status === 204) continue;
    const body = await res.json().catch(() => null);
    const statuses = new Map(((body && body.accounts) || []).map(a => [a.accountId, a.status]));
    for (const a of batch) {
      const st = statuses.get(a.accountId);
      if (st === 'closed') { await erasePersonalData(a.accountId); erased.push(a.accountId); }
      else if (st === 'updated' && PERSONAL_DATA_TABLE) await personalPut(a.accountId);
    }
  }
  return { ok: true, reported: accounts.length, erased, cyclePeriod };
}

// ---- Sesiones OAuth (tabla sessions) -------------------------------------------------------
async function sessionGet(sessionId) {
  if (!SESSIONS_TABLE) return memSessions.get(sessionId);
  const res = await ddbDoc.send(new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }));
  return res.Item;
}
async function sessionPut(session) {
  if (!SESSIONS_TABLE) { memSessions.set(session.sessionId, session); return; }
  await ddbDoc.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: { ...session, updatedAt: Date.now(), ttl: Math.floor((session.expiresAt || 0) / 1000) },
  }));
}
async function sessionDelete(sessionId) {
  if (!SESSIONS_TABLE) { memSessions.delete(sessionId); return; }
  await ddbDoc.send(new DeleteCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }));
}

async function atlassianPostJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Atlassian ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function atlassianGetJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Atlassian ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}
async function exchangeCode(code) {
  const t = await atlassianPostJson(`${AUTH_URL}/oauth/token`, {
    grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    code, redirect_uri: REDIRECT_URI,
  });
  return { access: t.access_token, refresh: t.refresh_token, expiresIn: Number(t.expires_in || 3600) };
}
async function refreshAccess(session) {
  const t = await atlassianPostJson(`${AUTH_URL}/oauth/token`, {
    grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: session.refresh,
  });
  session.access = t.access_token;
  if (t.refresh_token) session.refresh = t.refresh_token; // refresh rotatorio
  session.expiresAt = Date.now() + Number(t.expires_in || 3600) * 1000;
  return session;
}
async function accessibleResources(token) {
  return atlassianGetJson(`${API_URL}/oauth/token/accessible-resources`, token);
}
async function ensureToken(session) {
  if (Date.now() < (session.expiresAt || 0) - 30_000) return session;
  const upd = await refreshAccess(session);
  await sessionPut(upd);
  return upd;
}

// ---- Helpers de respuesta / routing -------------------------------------------------
const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', ...(extra.headers || {}) },
  cookies: extra.cookies,
  body: JSON.stringify(body),
});
const redirect = (location, cookies = []) => ({
  statusCode: 302,
  headers: { location, 'content-type': 'text/plain; charset=utf-8' },
  cookies,
});

function cookie(name, value, maxAge) {
  let c = `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  if (maxAge) c += `; Max-Age=${maxAge}`;
  if (COOKIE_DOMAIN) c += `; Domain=${COOKIE_DOMAIN}`;
  return c;
}
function parseCookies(event) {
  const map = {};
  for (const c of event.cookies || []) {
    const i = c.indexOf('=');
    if (i > 0) map[c.slice(0, i)] = decodeURIComponent(c.slice(i + 1));
  }
  return map;
}
function queryString(event) {
  const q = event.queryStringParameters || {};
  const out = {};
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw Object.assign(new Error('Body JSON inválido'), { status: 400 }); }
}

const jiraFor = session => createJiraApi({
  baseUrl: `${API_URL}/ex/jira/${session.cloudId}`,
  headers: () => ({ Authorization: `Bearer ${session.access}` }),
});

async function requireSession(event) {
  if (process.env.AUTH_MOCKED === '1') {
    return { sessionId: 'mock', accountId: 'MOCK-USER', displayName: 'Mock', email: 'mock@example.com', cloudId: 'cloud-mock', access: '', refresh: '', expiresAt: Date.now() + 1e9 };
  }
  const sid = parseCookies(event)[SESSION_COOKIE];
  if (!sid) throw Object.assign(new Error('No autenticado'), { status: 401 });
  const session = await sessionGet(sid);
  if (!session) throw Object.assign(new Error('Sesión no válida'), { status: 401 });
  return { sessionId: sid, ...session };
}
async function withJira(event, fn) {
  const auth = await requireSession(event);
  let sess;
  try {
    sess = await ensureToken(auth);
  } catch (e) {
    throw Object.assign(new Error('La sesión de Atlassian expiró. Vuelve a entrar.'), { status: 401 });
  }
  const result = await fn(jiraFor(sess));
  return result;
}

// ---- Auth flows -----------------------------------------------------------
async function loginRoute(event) {
  const state = randomUUID().replace(/-/g, '');
  const authorize = `${AUTH_URL}/authorize?${new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    response_type: 'code',
    prompt: 'consent',
  })}`;
  return redirect(authorize, [cookie(STATE_COOKIE, state, STATE_MAX_AGE)]);
}

async function callbackRoute(event) {
  const q = queryString(event);
  const cookies = parseCookies(event);
  const state = (q.state || '').slice(0, 64);
  if (!state || state !== cookies[STATE_COOKIE]) {
    return json(400, { error: 'State inválido (CSRF). Vuelve a iniciar sesión.' }, { cookies: [expireCookie(STATE_COOKIE)] });
  }
  const code = (q.code || '').slice(0, 5000);
  if (!code) return json(400, { error: 'Falta el código de autorización' });
  const tok = await exchangeCode(code);
  const resources = await accessibleResources(tok.access);
  const site = resources.find(r => r.url === SITE_URL) || resources.find(r => SITE_URL.startsWith(r.url));
  if (!site) {
    return json(403, { error: `El usuario no pertenece al sitio ${SITE_URL}` }, { cookies: [expireCookie(STATE_COOKIE)] });
  }
  const meRes = await fetch(`${API_URL}/ex/jira/${site.id}/rest/api/3/myself`, {
    headers: { Authorization: `Bearer ${tok.access}` },
  });
  const meText = await meRes.text();
  const me = meRes.ok ? JSON.parse(meText || '{}') : { accountId: '', displayName: String((tok.access || '').slice(0, 6)) };
  const sessionId = randomUUID();
  const session = {
    sessionId,
    accountId: me.accountId || '',
    displayName: me.displayName || me.emailAddress || 'Usuario',
    email: me.emailAddress || '',
    cloudId: site.id,
    access: tok.access,
    refresh: tok.refresh,
    expiresAt: Date.now() + tok.expiresIn * 1000,
  };
  await sessionPut(session);
  await personalPut(me.accountId || session.accountId); // registramos la cuenta cuyo token guardamos
  return redirect(APP_ORIGIN + '/', [
    cookie(STATE_COOKIE, '', -1),
    cookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE),
  ]);
}
function expireCookie(name) { return cookie(name, '', -1); }

async function meRoute(event) {
  const auth = await requireSession(event);
  return json(200, {
    accountId: auth.accountId, displayName: auth.displayName, email: auth.email, cloudId: auth.cloudId,
  });
}
async function logoutRoute(event) {
  const cookies = parseCookies(event);
  const sid = cookies[SESSION_COOKIE];
  if (sid) await sessionDelete(sid);
  return redirect(APP_ORIGIN + '/', [expireCookie(SESSION_COOKIE), expireCookie(STATE_COOKIE)]);
}

// ---- Routes -------------------------------------------------------------------
async function route(event) {
  const method = event.requestContext && event.requestContext.http ? event.requestContext.http.method : 'GET';
  const path = event.rawPath || '/';

  if (path === '/auth/login') return loginRoute(event);
  if (path === '/auth/callback') return callbackRoute(event);
  if (path === '/auth/logout') return logoutRoute(event);
  if (path === '/auth/me') return meRoute(event);

  if (path === '/api/planner/sessions') {
    await requireSession(event);
    if (method === 'GET') {
      const cur = await plannerGet();
      return json(200, { itemUpdatedAt: cur.itemUpdatedAt, sessions: cur.sessions || [] });
    }
    if (method === 'POST') {
      const body = parseBody(event);
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      if (JSON.stringify(sessions).length > 1_000_000) throw Object.assign(new Error('Sesión demasiado grande'), { status: 413 });
      try {
        const res = await plannerPut(sessions, body.baseUpdatedAt ? Number(body.baseUpdatedAt) : null);
        await personalTouchSessions(sessions); // referencias personales guardadas en el plan compartido
        return json(200, res);
      } catch (e) {
        if (e.status === 409) {
          return json(409, { error: e.message, itemUpdatedAt: e.current.itemUpdatedAt, sessions: e.current.sessions || [] });
        }
        throw e;
      }
    }
    if (method === 'DELETE') {
      const body = parseBody(event);
      if (!body.id) throw Object.assign(new Error('Falta id'), { status: 400 });
      const res = await plannerDelete(String(body.id));
      return json(200, res);
    }
    throw Object.assign(new Error(`Método no soportado ${method}`), { status: 405 });
  }

  if (path === '/api/jira/sprints' && method === 'GET') {
    return withJira(event, async jira => {
      const q = queryString(event);
      const board = Number(q.board) || 1;
      return json(200, await jira.jiraSprints(board));
    });
  }
  if (path === '/api/jira/stories' && method === 'GET') {
    return withJira(event, async jira => {
      const q = queryString(event);
      const sprint = q.sprint || '';
      if (!sprint) throw Object.assign(new Error('Falta ?sprint=<id|backlog>'), { status: 400 });
      const projectKey = q.projectKey || 'SCRUM';
      const board = Number(q.board) || 1;
      return json(200, await jira.jiraStories(board, projectKey, sprint));
    });
  }
  if (path === '/api/jira/members' && method === 'GET') {
    return withJira(event, async jira => {
      const q = queryString(event);
      return json(200, await jira.jiraMembers(q.projectKey || 'SCRUM'));
    });
  }
  if (path === '/api/jira/team' && method === 'GET') {
    return withJira(event, async jira => {
      const q = queryString(event);
      const roles = await jira.teamMembers(q.projectKey || 'SCRUM');
      return json(200, { devs: roles.devs, qas: roles.qas, all: roles.all });
    });
  }
  if (path === '/api/jira/story-hours' && method === 'POST') {
    return withJira(event, async jira => {
      const body = parseBody(event);
      const key = String(body.key || '').trim();
      if (!/^[A-Za-z]+-\d+$/.test(key)) throw Object.assign(new Error('Falta un key Jira válido (p.ej. SCRUM-123)'), { status: 400 });
      const fields = buildStoryFields(body.dev, body.qa);
      if (!Object.keys(fields).length) {
        return json(200, { ok: true, key, fields: {}, note: 'Sin horas numéricas que escribir (null/undefined omitido)' });
      }
      const result = await jira.updateStoryHours(key, fields);
      return json(200, { ok: true, key, ...result });
    });
  }

  throw Object.assign(new Error(`No route: ${method} ${path}`), { status: 404 });
}

export async function handler(event) {
  try {
    if (event && event.source === 'aws.events') {
      // Disparo programado (EventBridge Schedule): reporte semanal de datos personales.
      return json(200, await runPrivacyReporter());
    }
    return await route(event);
  } catch (e) {
    const status = e.status || 502;
    console.error(`[lambda] ${e.message}`);
    return json(status, { error: e.message });
  }
}

// exports documentados (purezas re-exportadas para test compartido si se necesita)
export { jiraPriority, parseHours, hoursToJira, buildStoryFields, requiredAsTbd, STORY_DEV_FIELD, STORY_QA_FIELD };
export const __internals = { memSessions, memPersonal };