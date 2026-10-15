#!/usr/bin/env node
// Local UI for platepuller: a small HTTP server on 127.0.0.1 that serves the page and
// runs publishes. Every API call needs the per-launch token embedded in the page, so
// other websites open in the browser cannot drive it.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FRAME_MATCH } from '../encode.js';
import { VARIABLES } from '../template.js';
import { COLOR_MODES, DEFAULTS, EXR_COMPRESSION, SCALES, loadPresets, preparePublish, runPublish } from '../publish.js';
import { pick, reveal, openBrowser } from './dialogs.js';
import { OPENEXR_COMPRESSION, openexrStatus } from '../openexr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '4317' },
    open: { type: 'boolean', default: false },
    presets: { type: 'string' },
  },
});

const TOKEN = crypto.randomBytes(24).toString('hex');
const presets = loadPresets(args.presets);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---- the one publish that can run at a time ------------------------------------------

let run = null; // { events: [], clients: Set<res>, controller, running }

function emit(event) {
  run.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.clients) res.write(line);
  if (event.type === 'end') for (const res of run.clients) res.end();
}

function summarize(plan) {
  const clips = plan.edit?.clips ?? [];
  const firstJob = new Map();
  for (const j of plan.jobs) if (!firstJob.has(j.index)) firstJob.set(j.index, j);
  return {
    errors: plan.errors,
    notes: plan.notes,
    out: plan.out ?? null,
    editSource: plan.editSource ?? null,
    sequenceName: plan.edit?.sequenceName ?? null,
    outputs: plan.outputs.map((o) => ({ preset: o.preset, color: o.color, colorSpace: o.colorSpace, kind: presets[o.preset]?.kind })),
    clips: clips.map((c, i) => {
      const j = firstJob.get(i);
      return {
        index: i,
        shot: j?.shot ?? null,
        name: c.name,
        source: c.file.name ?? path.basename(c.file.path),
        sourcePath: c.file.path,
        in: c.in,
        out: c.out - 1,
        duration: c.out - c.in,
        head: j?.range.head ?? null,
        tail: j?.range.tail ?? null,
        warnings: j?.warnings ?? [],
      };
    }),
    jobs: plan.jobs.map((j) => ({
      id: j.id,
      clip: j.index,
      output: j.output.index,
      path: j.outPath,
      rel: path.relative(plan.out, j.displayPath),
      size: `${j.size.width}x${j.size.height}`,
      frameRange: j.seq ? `${j.seq.start}–${j.seq.start + j.range.frames - 1}` : null,
      frames: j.range.frames,
      status: j.status,
    })),
  };
}

async function startRun(settings) {
  if (run?.running) throw Object.assign(new Error('A publish is already running.'), { status: 409 });
  const controller = new AbortController();
  run = { events: [], clients: run?.clients ?? new Set(), controller, running: true };
  try {
    const plan = await preparePublish(settings, presets);
    if (plan.errors.length) throw Object.assign(new Error(plan.errors.join('\n')), { status: 400 });
    emit({ type: 'plan', plan: summarize(plan) });
    runPublish(plan, { onEvent: emit, signal: controller.signal })
      .catch((err) => emit({ type: 'error', message: err.message }))
      .finally(() => {
        run.running = false;
        emit({ type: 'end' });
      });
  } catch (err) {
    run.running = false;
    throw err;
  }
}

// ---- HTTP ---------------------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

const API = {
  async meta() {
    return {
      version: pkg.version,
      presets,
      colorModes: COLOR_MODES,
      scales: SCALES,
      exrCompression: EXR_COMPRESSION,
      openexr: { ...openexrStatus(), needs: [...OPENEXR_COMPRESSION] },
      variables: VARIABLES,
      defaults: DEFAULTS,
      frameMatch: FRAME_MATCH,
    };
  },
  async plan(body) {
    return summarize(await preparePublish(body.settings ?? {}, presets));
  },
  async pick(body) {
    return { path: await pick(body.kind, body.initial) };
  },
  async run(body) {
    await startRun(body.settings ?? {});
    return { ok: true };
  },
  async cancel() {
    run?.controller.abort();
    return { ok: true };
  },
  async status() {
    return { running: Boolean(run?.running) };
  },
  /** Forget a finished run, so reloads and new jobs start clean. */
  async clear() {
    if (run && !run.running) run.events = [];
    return { ok: true };
  },
  async reveal(body) {
    reveal(body.path);
    return { ok: true };
  },
};

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
  let body = fs.readFileSync(full);
  if (file === 'index.html') body = body.toString('utf8').replace('__TOKEN__', TOKEN);
  send(res, 200, body, MIME[path.extname(full)] ?? 'application/octet-stream');
}

function createServer(port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    // DNS-rebinding guard: only answer to our own host name.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { app: 'platepuller' });
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    }

    const token = req.headers['x-platepuller-token'] ?? url.searchParams.get('token');
    if (token !== TOKEN) return send(res, 403, { error: 'Missing or wrong token. Reload the page.' });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      if (!run) run = { events: [], clients: new Set(), running: false };
      for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }

    const name = url.pathname.replace(/^\/api\//, '');
    if (req.method !== 'POST' || !API[name]) return send(res, 404, { error: 'Not found' });
    try {
      send(res, 200, await API[name](await readJson(req)));
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  });
}

async function alreadyRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).app === 'platepuller';
  } catch {
    return false;
  }
}

async function main() {
  const port = Number(args.port);
  const url = `http://127.0.0.1:${port}/`;
  if (await alreadyRunning(port)) {
    console.log(`platepuller is already running at ${url}`);
    if (args.open) openBrowser(url);
    return;
  }
  const server = createServer(port);
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Start with --port <n>.` : err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`platepuller ${pkg.version} UI running at ${url}`);
    console.log('Close this window to stop it.');
    if (args.open) openBrowser(url);
  });
}

main();
