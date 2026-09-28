import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiraApi, jiraPriority, parseHours, hoursToJira, buildStoryFields, requiredAsTbd } from './planner-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = JSON.parse(await readFile(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT || config.port || 8080);
const BASE_URL = (process.env.JIRA_BASE_URL || config.baseUrl || '').replace(/\/+$/, '');
const EMAIL = process.env.JIRA_EMAIL || config.email || '';
const TOKEN = process.env.JIRA_TOKEN || config.token || '';
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || config.projectKey || '';
const PAT = process.env.JIRA_PAT || config.pat || '';
const BOARD_ID = Number(process.env.JIRA_BOARD_ID || config.boardId || 1);

const LIVE_RELOAD = process.env.LIVE_RELOAD !== '0' && config.liveReload !== false;

const RELOAD_CLIENTS = new Set();
let reloadTimer = null;
function notifyReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const client of RELOAD_CLIENTS) {
      try { client.write('data: reload\n\n'); } catch (_) { RELOAD_CLIENTS.delete(client); }
    }
  }, 150);
}
if (LIVE_RELOAD) {
  watch(__dirname, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (filename.startsWith('.git') || filename.endsWith('~')) return;
    notifyReload();
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function authHeaders() {
  if (PAT) return { Authorization: `Bearer ${PAT}` };
  return { Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64') };
}

const jira = createJiraApi({
  baseUrl: BASE_URL,
  headers: () => authHeaders(),
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const RELOAD_SCRIPT = `<script>(function(){if(!location.host||location.protocol==='file:')return;var es=new EventSource('/__reload');es.onmessage=function(m){if(m.data==='reload')location.reload();};})();<\/script>`;

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = urlPath === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  try {
    let body = await readFile(filePath, 'utf8');
    if (LIVE_RELOAD && ext === '.html') {
      body = body.includes('</body>')
        ? body.replace('</body>', RELOAD_SCRIPT + '</body>')
        : body + RELOAD_SCRIPT;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function serveReloadSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  RELOAD_CLIENTS.add(res);
  req.on('close', () => RELOAD_CLIENTS.delete(res));
}

function checkConfig() {
  return { ok: !!BASE_URL && !!(PAT || (EMAIL && TOKEN)), key: PROJECT_KEY };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/__reload') {
    if (LIVE_RELOAD) return serveReloadSse(req, res);
    return sendJson(res, 404, { error: 'Live reload desactivado' });
  }
  if (url.pathname === '/api/jira/members') {
    const cfg = checkConfig();
    if (!cfg.ok) return sendJson(res, 500, { error: 'Faltan credenciales/baseUrl en config.json' });
    const key = url.searchParams.get('projectKey') || cfg.key;
    if (!key) return sendJson(res, 500, { error: 'Falta projectKey (config.json o ?projectKey=)' });
    try { sendJson(res, 200, await jira.jiraMembers(key)); }
    catch (e) { console.error('[proxy] Error:', e.message); sendJson(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/jira/team') {
    const cfg = checkConfig();
    if (!cfg.ok) return sendJson(res, 500, { error: 'Faltan credenciales/baseUrl en config.json' });
    const key = url.searchParams.get('projectKey') || cfg.key;
    if (!key) return sendJson(res, 500, { error: 'Falta projectKey (config.json o ?projectKey=)' });
    try { sendJson(res, 200, await jira.teamMembers(key)); }
    catch (e) { console.error('[proxy] Error:', e.message); sendJson(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/jira/sprints') {
    const cfg = checkConfig();
    if (!cfg.ok) return sendJson(res, 500, { error: 'Faltan credenciales/baseUrl en config.json' });
    try {
      const board = Number(url.searchParams.get('board')) || BOARD_ID;
      sendJson(res, 200, await jira.jiraSprints(board));
    } catch (e) { console.error('[proxy] Error:', e.message); sendJson(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/jira/stories') {
    const cfg = checkConfig();
    if (!cfg.ok) return sendJson(res, 500, { error: 'Faltan credenciales/baseUrl en config.json' });
    const key = url.searchParams.get('projectKey') || cfg.key;
    const sprint = url.searchParams.get('sprint');
    if (!key) return sendJson(res, 500, { error: 'Falta projectKey (config.json o ?projectKey=)' });
    if (!sprint) return sendJson(res, 500, { error: 'Falta ?sprint=<id|backlog>' });
    try {
      const board = Number(url.searchParams.get('board')) || BOARD_ID;
      sendJson(res, 200, await jira.jiraStories(board, key, sprint));
    } catch (e) { console.error('[proxy] Error:', e.message); sendJson(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/jira/story-hours' && req.method === 'POST') {
    const cfg = checkConfig();
    if (!cfg.ok) return sendJson(res, 500, { error: 'Faltan credenciales/baseUrl en config.json' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'Body JSON inválido: ' + e.message }); }
    const key = String((body && body.key) || '').trim();
    if (!/^[A-Za-z]+-\d+$/.test(key)) return sendJson(res, 400, { error: 'Falta un key Jira válido (p.ej. SCRUM-123)' });
    const fields = buildStoryFields(body && body.dev, body && body.qa);
    if (!Object.keys(fields).length) {
      return sendJson(res, 200, { ok: true, key, fields: {}, note: 'Sin horas numéricas que escribir (null/undefined omitido)' });
    }
    try {
      const result = await jira.updateStoryHours(key, fields);
      sendJson(res, 200, { ok: true, key, ...result });
    } catch (e) { console.error('[proxy] Error:', e.message); sendJson(res, 502, { error: e.message }); }
    return;
  }
  serveStatic(req, res);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`[proxy] Sirviendo http://localhost:${PORT}  (Jira: ${BASE_URL || 'SIN config'})`);
    if (LIVE_RELOAD) console.log('[proxy] Live reload: ON (recarga al guardar .html/.js/.css)');
  });
}

const jiraStories = (b, k, s) => jira.jiraStories(b, k, s);
const jiraSprints = b => jira.jiraSprints(b);

export { jiraStories, jiraSprints, jiraPriority, parseHours, hoursToJira, buildStoryFields, requiredAsTbd };