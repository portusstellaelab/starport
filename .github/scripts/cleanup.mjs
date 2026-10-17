// Starport Fencing Live: list every event and delete the ones past their 7 days.
// Runs nightly from GitHub Actions. Needs the FIREBASE_SERVICE_ACCOUNT secret.
const DB = (process.env.DB_URL || '').replace(/\/+$/, '');
const DRY = String(process.env.DRY_RUN || '') === 'true';
const EMU_NS = process.env.EMULATOR_NS || '';           // only for local testing
const KEEP_DAYS = 7, DAY = 86400000;

async function getToken() {
  if (EMU_NS) return 'owner';
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email'],
  });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  return t.token || t;
}
async function call(token, method, path, body, query) {
  const q = new URLSearchParams(query || {});
  if (EMU_NS) q.set('ns', EMU_NS);
  const url = DB + (path || '/') + '.json' + (q.toString() ? '?' + q : '');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + (await r.text()));
  return r.json();
}
function expiryOf(meta) {
  if (!meta) return 0;
  if (typeof meta.expiresAt === 'number') return meta.expiresAt;
  let base = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(meta.date || '')) base = Date.parse(meta.date + 'T23:59:59+11:00');
  if (!base) base = meta.createdAt || 0;
  return base ? base + KEEP_DAYS * DAY : 0;
}
const fmt = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '?';

const token = await getToken();
const codes = Object.keys((await call(token, 'GET', '/events', undefined, { shallow: 'true' })) || {});
const secretCodes = Object.keys((await call(token, 'GET', '/secrets', undefined, { shallow: 'true' })) || {});
const now = Date.now(), rows = [], del = [];
for (const code of codes) {
  const meta = await call(token, 'GET', '/events/' + code + '/public/meta');
  const exp = expiryOf(meta);
  const fencers = Object.keys((await call(token, 'GET', '/events/' + code + '/public/fencers', undefined, { shallow: 'true' })) || {}).length;
  let status = 'active';
  if (!meta) status = 'broken (no details)';
  else if (meta.deleted) status = 'deleted by host';
  else if (exp && now > exp) status = 'expired';
  if (status !== 'active') del.push(code);
  rows.push({ code, name: (meta && meta.name) || '-', date: (meta && meta.date) || '-', fencers, deletes: fmt(exp), status });
}
// PIN records left behind by events that no longer exist (older than a day)
for (const code of secretCodes) {
  if (codes.includes(code)) continue;
  const sec = await call(token, 'GET', '/secrets/' + code + '/createdAt');
  if (!sec || now - sec > DAY) { del.push(code); rows.push({ code, name: '(PINs only)', date: '-', fencers: 0, deletes: '-', status: 'orphan' }); }
}
console.table(rows);
let removed = 0;
if (!DRY) {
  for (const code of [...new Set(del)]) {
    await call(token, 'PATCH', '/', { ['events/' + code]: null, ['secrets/' + code]: null });
    removed++;
  }
}
const summary = ['## Fencing Live events', '', `${rows.length} found · ${DRY ? 'list only (nothing deleted)' : removed + ' deleted'}`, '',
  '| Code | Event | Date | Fencers | Auto-delete on | Status |', '|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.code} | ${String(r.name).replace(/\|/g, '/')} | ${r.date} | ${r.fencers} | ${r.deletes} | ${r.status}${!DRY && del.includes(r.code) ? ' → removed' : ''} |`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) { const fs = await import('node:fs'); fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); }
console.log(summary);
