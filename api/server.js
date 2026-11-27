// Weekend Cricket API — matches, team rosters, season stats, live scores.
// Plain Node.js http server + PostgreSQL. Prometheus metrics on :8080/metrics (not exposed by the route).
'use strict';
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const client = require('prom-client');
const { matchAwards } = require('./awards');

const PORT = +process.env.PORT || 8080;
const PIN = process.env.SCORER_PIN || '';
const pool = new Pool({
  host: process.env.DB_HOST || 'postgresql',
  port: +process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cricket',
  max: 5,
  connectionTimeoutMillis: 5000,
});
pool.on('error', e => log('error', 'db pool error', { err: e.message }));

// ---------- metrics ----------
client.collectDefaultMetrics({ prefix: 'cricket_api_' });
const reqs = new client.Counter({ name: 'cricket_api_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'code'] });
const dur = new client.Histogram({ name: 'cricket_api_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] });
const dbUp = new client.Gauge({ name: 'cricket_db_up', help: '1 if the API can reach PostgreSQL' });
const balls = new client.Counter({ name: 'cricket_match_saves_total', help: 'Match state saves received' });
const matchesG = new client.Gauge({ name: 'cricket_matches', help: 'Matches stored, by status', labelNames: ['status'] });
const viewersG = new client.Gauge({ name: 'cricket_live_viewers', help: 'Open live-score connections' });

// ---------- live push (Server-Sent Events) ----------
const subs = new Map(); // match id -> Set of open responses
function broadcast(id, payload) {
  const set = subs.get(id); if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const r of set) r.write(data);
}

// ---------- helpers ----------
function log(level, msg, extra = {}) { console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra })); }
function send(res, code, body, headers = {}) {
  const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function pinOk(req) {
  if (!PIN) return false; // no PIN configured = read-only server
  const got = Buffer.from(String(req.headers['x-scorer-pin'] || ''));
  const want = Buffer.from(PIN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const ID_RE = /^[A-Za-z0-9]{4,16}$/;
const clean = s => String(s ?? '').trim().slice(0, 60);
const key = s => clean(s).toLowerCase();

// ---------- schema ----------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      status text NOT NULL DEFAULT 'play',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS matches_updated_idx ON matches (updated_at DESC);
    CREATE TABLE IF NOT EXISTS teams (
      key text PRIMARY KEY,
      name text NOT NULL,
      players jsonb NOT NULL DEFAULT '[]',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS captain text NOT NULL DEFAULT '';`);
}

// ---------- summaries & stats ----------
function summary(id, st, status, updated) {
  const t = (st.teams || []).map(x => x.name);
  const inns = (st.inns || []).map(i => ({ team: (st.teams[i.bat] || {}).name, runs: i.runs, wk: i.wk, balls: i.balls }));
  let mom = null;
  if (status === 'finished') { try { const a = matchAwards(st); mom = a && a.mom ? { name: a.mom.name, team: a.mom.team, line: a.mom.line } : null; } catch { /* old data */ } }
  return { id, status, updated_at: updated, teams: t, overs: st.overs, innings: inns, result: st.result || '', mom };
}
function computeStats(rows) {
  const P = new Map(), Tm = new Map();
  const pl = (name, team) => {
    const k = key(name); if (!k || /^player \d+$/.test(k)) return null; // skip placeholder names
    if (!P.has(k)) P.set(k, { name: clean(name), team: clean(team), matches: new Set(), inns: 0, runs: 0, balls: 0, f4: 0, f6: 0, outs: 0, hs: 0, hsNo: false, bBalls: 0, bRuns: 0, wkts: 0, wd: 0, nb: 0, best: [0, 0] });
    return P.get(k);
  };
  const tm = name => { const k = key(name); if (!Tm.has(k)) Tm.set(k, { name: clean(name), played: 0, won: 0, lost: 0, tied: 0 }); return Tm.get(k); };
  const momCount = new Map();
  for (const { id, state: st } of rows) {
    if (!st || !Array.isArray(st.inns) || st.inns.length < 2) continue;
    try { const a = matchAwards(st); if (a && a.mom && !/^player \d+$/.test(key(a.mom.name))) { const k = key(a.mom.name); const c = momCount.get(k) || { name: a.mom.name, team: a.mom.team, awards: 0 }; c.awards++; momCount.set(k, c); } } catch { /* skip */ }
    for (const i of st.inns) {
      const batTeam = (st.teams[i.bat] || {}).name, bowlTeam = (st.teams[i.bowl] || {}).name;
      for (const b of i.bats || []) {
        const p = pl(b.n, batTeam); if (!p) continue;
        p.matches.add(id); p.inns++; p.runs += b.r | 0; p.balls += b.b | 0; p.f4 += b.f4 | 0; p.f6 += b.f6 | 0;
        const out = !!b.out && !b.ret; if (out) p.outs++;
        if ((b.r | 0) > p.hs || ((b.r | 0) === p.hs && !out)) { p.hs = b.r | 0; p.hsNo = !out; }
      }
      for (const b of i.bowls || []) {
        const p = pl(b.n, bowlTeam); if (!p) continue;
        p.matches.add(id); p.bBalls += b.balls | 0; p.bRuns += b.r | 0; p.wkts += b.w | 0; p.wd += b.wd | 0; p.nb += b.nb | 0;
        if ((b.w | 0) > p.best[0] || ((b.w | 0) === p.best[0] && (b.r | 0) < p.best[1])) p.best = [b.w | 0, b.r | 0];
      }
    }
    const [a, b] = st.inns, ta = tm(st.teams[a.bat].name), tb = tm(st.teams[b.bat].name);
    ta.played++; tb.played++;
    if (a.runs > b.runs) { ta.won++; tb.lost++; } else if (b.runs > a.runs) { tb.won++; ta.lost++; } else { ta.tied++; tb.tied++; }
  }
  const players = [...P.values()].map(p => ({
    name: p.name, team: p.team, matches: p.matches.size,
    batting: { inns: p.inns, runs: p.runs, balls: p.balls, fours: p.f4, sixes: p.f6, outs: p.outs, highest: p.hs + (p.hsNo ? '*' : ''), avg: p.outs ? +(p.runs / p.outs).toFixed(2) : null, sr: p.balls ? +(p.runs * 100 / p.balls).toFixed(1) : null },
    bowling: { balls: p.bBalls, overs: Math.floor(p.bBalls / 6) + '.' + (p.bBalls % 6), runs: p.bRuns, wkts: p.wkts, wides: p.wd, noballs: p.nb, best: p.best[0] + '/' + p.best[1], econ: p.bBalls ? +(p.bRuns * 6 / p.bBalls).toFixed(2) : null },
  }));
  return {
    matches: rows.length,
    topRuns: players.filter(p => p.batting.inns).sort((x, y) => y.batting.runs - x.batting.runs || (y.batting.sr || 0) - (x.batting.sr || 0)).slice(0, 10),
    topWickets: players.filter(p => p.bowling.balls).sort((x, y) => y.bowling.wkts - x.bowling.wkts || (x.bowling.econ ?? 99) - (y.bowling.econ ?? 99)).slice(0, 10),
    topSixes: players.filter(p => p.batting.sixes).sort((x, y) => y.batting.sixes - x.batting.sixes).slice(0, 5),
    topMom: [...momCount.values()].sort((x, y) => y.awards - x.awards).slice(0, 5),
    teams: [...Tm.values()].sort((x, y) => y.won - x.won || x.lost - y.lost),
    players,
  };
}

// ---------- routes ----------
const routes = [];
const on = (method, pattern, needPin, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), pattern: pattern.replace('([A-Za-z0-9]{4,16})', ':id'), needPin, fn });

on('GET', '/healthz', false, async () => [200, { ok: true }]);
on('GET', '/api/healthz', false, async () => [200, { ok: true }]);
on('GET', '/api/readyz', false, async () => { await pool.query('SELECT 1'); return [200, { ok: true, db: 'up' }]; });
on('POST', '/api/pin-check', true, async () => [200, { ok: true }]);

on('GET', '/api/matches', false, async (req, m, url) => {
  const limit = Math.min(+url.searchParams.get('limit') || 50, 200);
  const r = await pool.query('SELECT id, state, status, updated_at FROM matches ORDER BY updated_at DESC LIMIT $1', [limit]);
  return [200, r.rows.map(x => summary(x.id, x.state, x.status, x.updated_at))];
});
// Matches being scored right now (in play and updated within the last 60 minutes)
on('GET', '/api/live', false, async () => {
  const r = await pool.query("SELECT id, state, status, updated_at FROM matches WHERE status = 'play' AND updated_at > now() - interval '60 minutes' ORDER BY updated_at DESC LIMIT 10");
  return [200, r.rows.map(x => summary(x.id, x.state, x.status, x.updated_at))];
});
// Live score stream: sends the match now, then every change the moment the scorer saves it
on('GET', '/api/matches/([A-Za-z0-9]{4,16})/events', false, async (req, m, url, res) => {
  const id = m[1];
  const r = await pool.query('SELECT state, status, updated_at FROM matches WHERE id=$1', [id]);
  if (!r.rows.length) return [404, { error: 'Match not found' }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({ id, status: r.rows[0].status, updated_at: r.rows[0].updated_at, state: r.rows[0].state })}\n\n`);
  if (!subs.has(id)) subs.set(id, new Set());
  subs.get(id).add(res); viewersG.inc();
  const hb = setInterval(() => res.write(': ping\n\n'), 15000); // keeps the router connection open
  req.on('close', () => { clearInterval(hb); const s = subs.get(id); if (s) { s.delete(res); if (!s.size) subs.delete(id); } viewersG.dec(); });
  return null; // response stays open
});
on('GET', '/api/matches/([A-Za-z0-9]{4,16})', false, async (req, m) => {
  const r = await pool.query('SELECT state, status, updated_at FROM matches WHERE id=$1', [m[1]]);
  if (!r.rows.length) return [404, { error: 'Match not found' }];
  return [200, { id: m[1], status: r.rows[0].status, updated_at: r.rows[0].updated_at, state: r.rows[0].state }];
});
on('PUT', '/api/matches/([A-Za-z0-9]{4,16})', true, async (req, m) => {
  const body = await readJson(req);
  const st = body.state;
  if (!st || typeof st !== 'object' || !Array.isArray(st.inns) || !Array.isArray(st.teams)) return [400, { error: 'state must be a match object' }];
  const status = st.phase === 'over' ? 'finished' : st.phase === 'abandoned' ? 'abandoned' : 'play';
  await pool.query(`INSERT INTO matches (id, state, status) VALUES ($1, $2, $3)
    ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, status = EXCLUDED.status, updated_at = now()`, [m[1], st, status]);
  balls.inc();
  broadcast(m[1], { id: m[1], status, updated_at: new Date().toISOString(), state: st });
  return [200, { ok: true, id: m[1], status }];
});
on('DELETE', '/api/matches/([A-Za-z0-9]{4,16})', true, async (req, m) => {
  const r = await pool.query('DELETE FROM matches WHERE id=$1', [m[1]]);
  return [r.rowCount ? 200 : 404, { ok: !!r.rowCount }];
});

on('GET', '/api/teams', false, async () => {
  const r = await pool.query('SELECT name, captain, players, updated_at FROM teams ORDER BY updated_at DESC');
  return [200, r.rows];
});
on('PUT', '/api/teams', true, async req => {
  const body = await readJson(req);
  const list = Array.isArray(body.teams) ? body.teams.slice(0, 20) : [];
  for (const t of list) {
    const name = clean(t.name); if (!name) continue;
    const players = [...new Set((Array.isArray(t.players) ? t.players : []).map(clean).filter(Boolean))].slice(0, 60);
    await pool.query(`INSERT INTO teams (key, name, captain, players) VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, captain = EXCLUDED.captain, players = EXCLUDED.players, updated_at = now()`, [key(name), name, clean(t.captain), JSON.stringify(players)]);
  }
  return [200, { ok: true, saved: list.length }];
});

on('GET', '/api/stats', false, async () => {
  const r = await pool.query("SELECT id, state FROM matches WHERE status = 'finished'");
  return [200, computeStats(r.rows)];
});

on('GET', '/api/export', false, async () => {
  const m = await pool.query('SELECT id, state, status, created_at, updated_at FROM matches ORDER BY created_at');
  const t = await pool.query('SELECT name, captain, players FROM teams ORDER BY name');
  return [200, { app: 'weekend-cricket', version: 1, exported_at: new Date().toISOString(), matches: m.rows, teams: t.rows },
    { 'Content-Disposition': `attachment; filename="cricket-backup-${new Date().toISOString().slice(0, 10)}.json"` }];
});
on('POST', '/api/import', true, async req => {
  const body = await readJson(req, 20 * 1024 * 1024);
  if (body.app !== 'weekend-cricket' || !Array.isArray(body.matches)) return [400, { error: 'Not a Weekend Cricket backup file' }];
  const c = await pool.connect(); let n = 0;
  try {
    await c.query('BEGIN');
    for (const x of body.matches) {
      if (!ID_RE.test(String(x.id)) || !x.state) continue;
      await c.query(`INSERT INTO matches (id, state, status, created_at, updated_at) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),COALESCE($5::timestamptz, now()))
        ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
        [x.id, x.state, x.status === 'finished' ? 'finished' : 'play', x.created_at || null, x.updated_at || null]);
      n++;
    }
    for (const t of body.teams || []) {
      const name = clean(t.name); if (!name) continue;
      await c.query(`INSERT INTO teams (key, name, captain, players) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, captain=EXCLUDED.captain, players=EXCLUDED.players, updated_at=now()`,
        [key(name), name, clean(t.captain), JSON.stringify((t.players || []).map(clean).filter(Boolean))]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  return [200, { ok: true, matches: n }];
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  const url = new URL(req.url, 'http://x');
  let route = 'unmatched', code = 500;
  try {
    if (url.pathname === '/metrics' && req.method === 'GET') {
      route = '/metrics'; code = 200;
      res.writeHead(200, { 'Content-Type': client.register.contentType }); res.end(await client.register.metrics());
      return;
    }
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) { const any = routes.some(r => r.re.test(url.pathname)); code = any ? 405 : 404; return send(res, code, { error: any ? 'Method not allowed' : 'Not found' }); }
    route = r.pattern;
    if (r.needPin && !pinOk(req)) { code = PIN ? 401 : 503; return send(res, code, { error: PIN ? 'Wrong or missing scorer PIN' : 'Server has no scorer PIN configured' }); }
    const out = await r.fn(req, url.pathname.match(r.re), url, res);
    if (!out) { code = 200; return; } // streaming response
    const [c, body, h] = out;
    code = c; send(res, c, body, h);
  } catch (e) {
    code = e.status || 500;
    if (code >= 500) log('error', 'request failed', { method: req.method, path: url.pathname, err: e.message });
    send(res, code, { error: code >= 500 ? 'Server error' : e.message });
  } finally {
    const s = Number(process.hrtime.bigint() - t0) / 1e9;
    reqs.inc({ method: req.method, route, code }); dur.observe({ method: req.method, route }, s);
    if (route !== '/metrics' && !route.endsWith('healthz') && route !== '/api/readyz') log('info', 'request', { method: req.method, path: url.pathname, code, ms: Math.round(s * 1000) });
  }
});

async function probeDb() {
  try {
    await pool.query('SELECT 1'); dbUp.set(1);
    const r = await pool.query('SELECT status, count(*)::int AS n FROM matches GROUP BY status');
    matchesG.reset(); for (const x of r.rows) matchesG.set({ status: x.status }, x.n);
  } catch (e) { dbUp.set(0); log('warn', 'db check failed', { err: e.message }); }
}

async function start() {
  for (let i = 1; ; i++) {
    try { await migrate(); break; } catch (e) {
      log('warn', 'waiting for database', { attempt: i, err: e.message });
      await new Promise(r => setTimeout(r, Math.min(2000 * i, 15000)));
    }
  }
  await probeDb(); setInterval(probeDb, 15000).unref();
  server.listen(PORT, () => log('info', 'listening', { port: PORT, pin: PIN ? 'set' : 'MISSING (read-only)' }));
}
process.on('SIGTERM', () => { log('info', 'shutting down'); for (const set of subs.values()) for (const r of set) r.end(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); });

if (require.main === module) start();
module.exports = { computeStats, server, pool, start };
