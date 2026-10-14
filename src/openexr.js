// Optional OpenEXR support (DWAA, DWAB, PIZ) through the official Python bindings, which
// live in a private virtual environment inside the platepuller folder (npm run setup-exr).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(here, 'exr_recompress.py');

/** EXR compressions FFmpeg cannot write; these sequences are written by OpenEXR instead. */
export const OPENEXR_COMPRESSION = new Set(['dwaa', 'dwab', 'piz']);

export function venvPython() {
  if (process.env.PLATEPULLER_PYTHON) return process.env.PLATEPULLER_PYTHON;
  const win = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  return process.platform === 'win32' ? win : path.join(ROOT, '.venv', 'bin', 'python');
}

let status = null;

/** { available, reason } — checked once per process. */
export function openexrStatus() {
  if (status) return status;
  const python = venvPython();
  if (!fs.existsSync(python)) {
    status = { available: false, reason: 'OpenEXR support is not set up. Run "npm run setup-exr" in the platepuller folder.' };
  } else {
    const r = spawnSync(python, [SCRIPT, '--check'], { encoding: 'utf8', windowsHide: true });
    status = r.status === 0 ? { available: true } : { available: false, reason: `OpenEXR Python package not usable: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}` };
  }
  return status;
}

/**
 * Write an EXR sequence through OpenEXR. The Python helper creates `spec.pipe` (a Windows
 * named pipe or a POSIX FIFO), then compresses the raw planar float frames ffmpeg writes into
 * it on several threads. Returns { ready, done }: start ffmpeg once `ready` resolves.
 * onProgress(n) after each written frame.
 */
export function serveExrSequence(spec, { onProgress, signal } = {}) {
  let markReady;
  let failReady;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => {}); // `done` carries the error

  const done = new Promise((resolve, reject) => {
    const fail = (err) => {
      failReady(err);
      reject(err);
    };
    if (signal?.aborted) return fail(new Error('cancelled'));
    const proc = spawn(venvPython(), [SCRIPT, '--serve', JSON.stringify(spec)], { windowsHide: true });
    const kill = () => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', kill, { once: true });
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') markReady();
        const m = line.match(/^done (\d+)/);
        if (m && onProgress) onProgress(Number(m[1]));
      }
    });
    proc.stderr.on('data', (d) => (stderr += d));
    let failure = null;
    proc.on('error', (err) => {
      failure = err;
      if (proc.pid === undefined) fail(err);
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) fail(new Error('cancelled'));
      else if (failure) fail(failure);
      else if (code === 0) resolve();
      else fail(new Error(`EXR encoding failed: ${stderr.trim().split('\n').pop()}`));
    });
  });
  return { ready, done };
}
