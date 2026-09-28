// mock-server.mjs — servidor de desarrollo SIN AWS/OAuth para probar el flujo completo:
// - sirve la app estática (index.html) igual que el proxy local
// - /auth/* y /api/planner/* -> handler Lambda real con AUTH_MOCKED=1 (usuario simulado
//   y sesiones compartidas en memoria, con conflicto 409 real)
// - /api/jira/* -> fixtures (sin llamar a Atlassian)
//
// Uso:  AUTH_MOCKED=1 node mock-server.mjs   ->  http://localhost:8090
// Ábrelo en DOS pestañas/ventanas distintas y edita en ambas para ver la sincronización
// compartida y el aviso de conflicto 409.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);

process.env.AUTH_MOCKED = '1';
const { handler } = await import('./lambda/handler.mjs');

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

const MOCK_MEMBERS = [
  { accountId: 'A1', displayName: 'Albin Ramirez', email: 'albin@example.com', active: true },
  { accountId: 'A2', displayName: 'Eliana Rodriguez', email: 'eliana@example.com', active: true },
  { accountId: 'A3', displayName: 'Jira Bot Xray', email: 'bot@example.com', active: true },
];
const MOCK_SPRINTS = [
  { id: 44, name: 'Sprint 21', state: 'future', startDate: '', endDate: '' },
  { id: 43, name: 'Sprint 20', state: 'future', startDate: '', endDate: '' },
  { id: 42, name: 'Sprint 19', state: 'active', startDate: '2026-09-14', endDate: '2026-09-25', goal: 'Onboarding WhatsApp' },
];
const MOCK_STORIES = [
  { id: 'SCRUM-1', title: 'Alta devqa', priority: 'alta', status: 'Ready for QA', carryOver: true, dev: 8, qa: 0.5, forcedDev: 'auto', forcedQa: 'auto', assignee: 'Albin Ramirez' },
  { id: 'SCRUM-2', title: 'Media normal', priority: 'media', status: 'To Do', carryOver: false, dev: null, qa: null, forcedDev: 'auto', forcedQa: 'auto', assignee: '' },
  { id: 'SCRUM-3', title: 'Baja tbd', priority: 'baja', status: 'To Do', carryOver: false, dev: 0, qa: null, forcedDev: 'auto', forcedQa: 'auto', assignee: '' },
];
const MOCK_TEAM = { devs: ['Albin Ramirez', 'Eduard Acevedo'], qas: ['Eliana Rodriguez', 'estefania.rodriguez'], all: ['Albin Ramirez', 'Eduard Acevedo', 'Eliana Rodriguez', 'estefania.rodriguez'] };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function toApiGwEvent(req, url, body) {
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    requestContext: { http: { method: req.method } },
    headers: req.headers,
    cookies: (req.headers.cookie || '').split(/;\s*/).filter(Boolean),
    body: body != null ? Buffer.from(JSON.stringify(body), 'utf8').toString('base64') : undefined,
    isBase64Encoded: body != null,
  };
}

function applyLambdaResponse(res, r) {
  res.writeHead(r.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', ...(r.headers || {}) });
  res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, pathname);
  const ext = path.extname(filePath).toLowerCase();
  try {
    const body = await readFile(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/api/jira/sprints') return sendJson(res, 200, MOCK_SPRINTS);
  if (p === '/api/jira/stories') {
    const sprint = url.searchParams.get('sprint');
    return sendJson(res, 200, sprint === 'backlog' ? MOCK_STORIES.slice(1) : MOCK_STORIES);
  }
  if (p === '/api/jira/members') return sendJson(res, 200, MOCK_MEMBERS);
  if (p === '/api/jira/team') return sendJson(res, 200, MOCK_TEAM);
  if (p === '/api/jira/story-hours' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, key: body.key, fields: {}, note: 'Mock: horas aceptadas' });
  }
  if (p.startsWith('/auth/') || p === '/api/planner/sessions') {
    const body = ['POST', 'DELETE'].includes(req.method) ? await readBody(req) : null;
    const r = await handler(toApiGwEvent(req, url, body));
    return applyLambdaResponse(res, r);
  }
  serveStatic(req, res, p);
});

server.listen(PORT, () => {
  console.log(`[mock] Sirviendo http://localhost:${PORT}  (auth simulado + sesiones en memoria, Jira = fixtures)`);
  console.log('[mock] Prueba de conflicto: edita en dos pestañas a la vez.');
});