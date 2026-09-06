import express from 'express';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Operator console.
 *
 * A web UI cannot start the server that serves it, so process control lives in
 * this separate supervisor process. It starts and stops the API server, streams
 * its logs, and proxies admin calls through to it once it is up.
 *
 * It can spawn processes, so it binds to 127.0.0.1 and nothing else. Do not
 * change that: reachable from the network, this is remote code execution.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const SERVER_DIR = path.join(ROOT, 'apps/server');

const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 4000);
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 3000);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const LIVEKIT_PORT = Number(process.env.LIVEKIT_PORT ?? 7880);

/**
 * LiveKit lives in infra/livekit in the repo and in livekit/ next to the
 * console in an installed copy, so look for both rather than assuming a layout.
 */
const LIVEKIT_DIR = [
  path.join(ROOT, 'infra/livekit'),
  path.resolve(__dirname, '../../livekit'),
].find((dir) => fs.existsSync(path.join(dir, 'livekit.yaml'))) ?? path.join(ROOT, 'infra/livekit');
const LIVEKIT_EXE = path.join(LIVEKIT_DIR, 'bin/livekit-server.exe');
const LIVEKIT_CONFIG = path.join(LIVEKIT_DIR, 'livekit.yaml');
/** The Windows service PostgreSQL 17 installs itself as. */
const DB_SERVICE = process.env.DB_SERVICE ?? 'postgresql-x64-17';

/* ------------------------------------------------------------------ state */

let child = null;
let startedAt = null;
let lastExit = null;

let lk = null;
let lkStartedAt = null;
let lkLastExit = null;
const LOG_LIMIT = 500;
const logs = [];

function log(stream, line) {
  for (const part of String(line).split(/\r?\n/)) {
    if (!part.trim()) continue;
    logs.push({ at: new Date().toISOString(), stream, line: part });
  }
  while (logs.length > LOG_LIMIT) logs.shift();
}

function readEnvPort() {
  try {
    const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL="?[^"\n]*?:(\d+)\//m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function tcpProbe(port, host = '127.0.0.1', timeout = 900) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/* -------------------------------------------------------- process control */

function startServer() {
  if (child) return { ok: false, error: 'Already running.' };

  const distMain = path.join(SERVER_DIR, 'dist/main.js');
  if (!fs.existsSync(distMain)) {
    return { ok: false, error: 'apps/server/dist/main.js not found — build it first.' };
  }

  child = spawn(process.execPath, ['dist/main.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env },
    windowsHide: true,
  });
  startedAt = Date.now();
  lastExit = null;
  log('console', `starting server (pid ${child.pid})`);

  child.stdout.on('data', (d) => log('out', d.toString()));
  child.stderr.on('data', (d) => log('err', d.toString()));
  child.on('exit', (code, signal) => {
    log('console', `server exited (code=${code} signal=${signal ?? 'none'})`);
    lastExit = { code, signal, at: new Date().toISOString() };
    child = null;
    startedAt = null;
  });

  return { ok: true, pid: child.pid };
}

/**
 * Voice is a second process, not part of the chat server, so "start" has to
 * start it too — otherwise the console says voice is down and nothing in the
 * UI explains that it was never launched.
 */
async function startLiveKit() {
  if (lk) return { ok: true, note: 'LiveKit already running', pid: lk.pid };

  // Someone may have started it from start.ps1 or the scheduled task. Adopting
  // the port is not possible, but a second bind would just fail, so say so.
  if (await tcpProbe(LIVEKIT_PORT)) {
    return { ok: true, note: `LiveKit already listening on :${LIVEKIT_PORT} (not started by this console)` };
  }

  if (!fs.existsSync(LIVEKIT_EXE)) {
    return {
      ok: false,
      error: `livekit-server.exe not found at ${LIVEKIT_EXE} — see the README in that folder for the download.`,
    };
  }

  lk = spawn(LIVEKIT_EXE, ['--config', LIVEKIT_CONFIG], {
    cwd: LIVEKIT_DIR,
    env: { ...process.env },
    windowsHide: true,
  });
  lkStartedAt = Date.now();
  lkLastExit = null;
  log('console', `starting LiveKit (pid ${lk.pid})`);

  lk.stdout.on('data', (d) => log('lk', d.toString()));
  lk.stderr.on('data', (d) => log('lk', d.toString()));
  lk.on('error', (e) => {
    log('err', `LiveKit failed to start: ${e.message}`);
    lk = null;
    lkStartedAt = null;
  });
  lk.on('exit', (code, signal) => {
    log('console', `LiveKit exited (code=${code} signal=${signal ?? 'none'})`);
    lkLastExit = { code, signal, at: new Date().toISOString() };
    lk = null;
    lkStartedAt = null;
  });

  return { ok: true, note: `LiveKit started (pid ${lk.pid})`, pid: lk.pid };
}

async function stopLiveKit() {
  if (!lk) return { ok: true, note: 'LiveKit not running' };
  const pid = lk.pid;
  log('console', `stopping LiveKit (pid ${pid})`);
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    lk.kill('SIGTERM');
  }
  for (let i = 0; i < 40 && lk; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: true, note: `LiveKit stopped (pid ${pid})` };
}

async function stopServer() {
  if (!child) return { ok: false, error: 'Not running.' };
  const pid = child.pid;
  log('console', `stopping server (pid ${pid})`);

  // On Windows a plain SIGTERM does not reliably reach a detached child, so
  // fall back to taskkill on the pid — never a blanket kill of node.exe.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }

  for (let i = 0; i < 40 && child; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: true };
}

/* ------------------------------------------------- kill by port, not name */

/**
 * Everything below finds processes by the port they hold and kills those pids.
 *
 * It must never kill by image name. `taskkill /IM node.exe` would take out this
 * console, every other Node process on the machine, and any editor or tool that
 * happens to run on Node. The port is the only identifier that means "the thing
 * I actually want to stop".
 */

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        out: String(stdout ?? ''),
        err: String(stderr ?? ''),
      });
    });
  });
}

/** Pids listening on a TCP port. Never includes this console's own pid. */
async function pidsOnPort(port) {
  const pids = new Set();

  if (process.platform === 'win32') {
    const { out } = await run('netstat', ['-ano', '-p', 'TCP']);
    // Split into columns rather than matching a built regex: "TCP  0.0.0.0:7880
    // 0.0.0.0:0  LISTENING  35828". Comparing the local column with ':7880'
    // included is also what stops port 7880 from matching 17880.
    for (const line of out.split(/\r?\n/)) {
      const col = line.trim().split(/\s+/);
      if (col[0] !== 'TCP' || col[3] !== 'LISTENING') continue;
      if (!col[1].endsWith(':' + port)) continue;
      pids.add(Number(col[4]));
    }
  } else {
    const { out } = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) pids.add(Number(line.trim()));
    }
  }

  pids.delete(0);
  pids.delete(process.pid);
  return [...pids];
}

async function killPids(pids) {
  const killed = [];
  for (const pid of pids) {
    // Belt and braces: pidsOnPort already excludes us, but nothing about this
    // function should be able to kill the console.
    if (pid === process.pid) continue;
    const r =
      process.platform === 'win32'
        ? await run('taskkill', ['/PID', String(pid), '/T', '/F'])
        : await run('kill', ['-9', String(pid)]);
    if (r.ok) killed.push(pid);
    else log('console', `could not kill pid ${pid}: ${(r.err || r.out).trim()}`);
  }
  return killed;
}

/** Stop whatever holds `port`, including instances this console did not start. */
async function killPort(port, label) {
  const pids = await pidsOnPort(port);
  if (pids.length === 0) return { ok: true, killed: [], note: `nothing on :${port}` };
  log('console', `killing ${label} on :${port} — pid(s) ${pids.join(', ')}`);
  const killed = await killPids(pids);
  return {
    ok: killed.length > 0,
    killed,
    note: killed.length ? `stopped ${label} (pid ${killed.join(', ')})` : `could not stop ${label}`,
  };
}

/* ------------------------------------------------------------- database */

async function serviceState(name) {
  if (process.platform !== 'win32') return 'unknown';
  const { out } = await run('sc', ['query', name]);
  if (/RUNNING/.test(out)) return 'running';
  if (/STOPPED/.test(out)) return 'stopped';
  return 'unknown';
}

/**
 * Postgres is a Windows service, so it is stopped as a service — killing its
 * pid would leave the service manager thinking it is still up, and an unclean
 * shutdown means recovery on next start.
 */
async function stopDatabase() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Only implemented for the Windows service.' };
  }
  const before = await serviceState(DB_SERVICE);
  if (before === 'stopped') return { ok: true, note: 'database already stopped' };

  log('console', `stopping database service ${DB_SERVICE}`);
  const r = await run('net', ['stop', DB_SERVICE]);
  const text = (r.out + r.err).trim();

  // Stopping a service needs elevation. `net stop` exits 2 with "Access is
  // denied" in its output, which does not say "run me as administrator" —
  // so say it here.
  if (!r.ok && /access is denied/i.test(text)) {
    return {
      ok: false,
      error: `Access denied stopping ${DB_SERVICE}. Run the console from an elevated terminal, or: net stop ${DB_SERVICE}`,
    };
  }
  if (!r.ok) return { ok: false, error: text || `net stop failed (code ${r.code})` };
  return { ok: true, note: `database stopped (${DB_SERVICE})` };
}

async function startDatabase() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Only implemented for the Windows service.' };
  }
  if ((await serviceState(DB_SERVICE)) === 'running') {
    return { ok: true, note: 'database already running' };
  }
  log('console', `starting database service ${DB_SERVICE}`);
  const r = await run('net', ['start', DB_SERVICE]);
  if (!r.ok) {
    return {
      ok: false,
      error:
        (r.out + r.err).trim() ||
        `Could not start ${DB_SERVICE} — an elevated terminal is usually the reason.`,
    };
  }
  return { ok: true, note: `database started (${DB_SERVICE})` };
}

/* -------------------------------------------------------------- npm tasks */

function runTask(name, args) {
  return new Promise((resolve) => {
    log('console', `running: npm ${args.join(' ')}`);
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: SERVER_DIR,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      log('task', d.toString());
    });
    p.stderr.on('data', (d) => {
      out += d;
      log('task', d.toString());
    });
    p.on('exit', (code) => {
      log('console', `${name} finished (code=${code})`);
      resolve({ ok: code === 0, code, output: out.slice(-4000) });
    });
  });
}

/* ----------------------------------------------------------------- routes */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/sv/status', async (req, res) => {
  const dbPort = readEnvPort();
  const [apiUp, dbUp, livekitUp, dbService] = await Promise.all([
    tcpProbe(SERVER_PORT),
    dbPort ? tcpProbe(dbPort) : Promise.resolve(false),
    tcpProbe(LIVEKIT_PORT),
    serviceState(DB_SERVICE),
  ]);

  let health = null;
  if (apiUp) {
    try {
      const r = await fetch(`${SERVER_URL}/api/health`, {
        signal: AbortSignal.timeout(2500),
      });
      health = await r.json();
    } catch {
      health = null;
    }
  }

  res.json({
    server: {
      managed: Boolean(child),
      pid: child?.pid ?? null,
      listening: apiUp,
      uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
      lastExit,
      port: SERVER_PORT,
      health,
    },
    database: {
      listening: dbUp,
      port: dbPort,
      service: DB_SERVICE,
      serviceState: dbService,
    },
    livekit: {
      listening: livekitUp,
      port: LIVEKIT_PORT,
      managed: Boolean(lk),
      pid: lk?.pid ?? null,
      uptimeSeconds: lkStartedAt ? Math.round((Date.now() - lkStartedAt) / 1000) : null,
      lastExit: lkLastExit,
      installed: fs.existsSync(LIVEKIT_EXE),
    },
    console: { port: CONSOLE_PORT },
  });
});

/**
 * Start is the whole stack, not just the API: voice is a separate process and
 * nobody pressing "Start server" means "start everything except voice".
 * A LiveKit that will not start is reported, but never stops the chat server
 * from coming up — text still works without voice.
 */
async function startAll() {
  const server = startServer();
  const livekit = await startLiveKit();
  return {
    ...server,
    livekit,
    error: server.error ?? (livekit.ok ? undefined : livekit.error),
  };
}

app.post('/sv/server/start', async (req, res) => res.json(await startAll()));
app.post('/sv/server/stop', async (req, res) => {
  const server = await stopServer();
  const livekit = await stopLiveKit();
  res.json({ ok: server.ok, error: server.error, livekit });
});
app.post('/sv/server/restart', async (req, res) => {
  if (child) await stopServer();
  await stopLiveKit();
  await new Promise((r) => setTimeout(r, 400));
  res.json(await startAll());
});

app.post('/sv/livekit/start', async (req, res) => res.json(await startLiveKit()));

/* ------------------------------------------------------------ stop things */

/**
 * `stop` only ends the child this console started. These end whatever is
 * actually holding the port, including a server someone left running in
 * another terminal — which was previously impossible to clear from here.
 */
app.post('/sv/kill/server', async (req, res) => {
  if (child) await stopServer();
  res.json(await killPort(SERVER_PORT, 'chat server'));
});

app.post('/sv/kill/livekit', async (req, res) => {
  if (lk) await stopLiveKit();
  res.json(await killPort(LIVEKIT_PORT, 'LiveKit'));
});

app.post('/sv/database/stop', async (req, res) => res.json(await stopDatabase()));
app.post('/sv/database/start', async (req, res) => res.json(await startDatabase()));

/** Everything, in dependency order: clients of the database before it. */
app.post('/sv/kill/all', async (req, res) => {
  const steps = [];
  if (child) await stopServer();
  steps.push({ what: 'server', ...(await killPort(SERVER_PORT, 'chat server')) });
  if (lk) await stopLiveKit();
  steps.push({ what: 'livekit', ...(await killPort(LIVEKIT_PORT, 'LiveKit')) });
  steps.push({ what: 'database', ...(await stopDatabase()) });

  const failed = steps.filter((s) => !s.ok);
  res.json({
    ok: failed.length === 0,
    steps,
    error: failed.map((s) => s.error).filter(Boolean).join(' · ') || undefined,
  });
});

app.get('/sv/logs', (req, res) => {
  const since = Number(req.query.since ?? 0);
  res.json({ total: logs.length, lines: logs.slice(Math.max(0, since)) });
});

app.post('/sv/logs/clear', (req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

app.post('/sv/task/:name', async (req, res) => {
  const tasks = {
    build: ['run', 'build'],
    migrate: ['run', 'db:deploy'],
    seed: ['run', 'db:seed'],
    generate: ['run', 'db:generate'],
  };
  const args = tasks[req.params.name];
  if (!args) return res.status(400).json({ ok: false, error: 'Unknown task.' });
  res.json(await runTask(req.params.name, args));
});

/**
 * Everything under /api is handed to the chat server, so the browser sees one
 * origin and there is no CORS or cookie-domain problem to work around.
 */
app.use('/api', async (req, res) => {
  try {
    const upstream = await fetch(`${SERVER_URL}/api${req.url}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text || '{}');
  } catch (e) {
    res.status(502).json({
      message: 'The chat server is not responding. Is it started?',
      detail: String(e?.message ?? e),
    });
  }
});

app.listen(CONSOLE_PORT, '127.0.0.1', () => {
  console.log(`\n  Server console:  http://127.0.0.1:${CONSOLE_PORT}\n`);
  console.log(`  Managing:        ${SERVER_DIR}`);
  console.log(`  Chat server:     ${SERVER_URL}`);
  console.log(`  LiveKit:         ${LIVEKIT_DIR}`);
  console.log(`  Bound to loopback only — it can start processes.\n`);
});

// Do not leave an orphaned server behind when the console itself exits.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (child) await stopServer();
    if (lk) await stopLiveKit();
    process.exit(0);
  });
}
