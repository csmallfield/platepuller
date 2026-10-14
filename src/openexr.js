// Optional OpenEXR support (DWAA, DWAB, PIZ) through the official Python bindings, which
// live in a private virtual environment inside the platepuller folder (npm run setup-exr).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(here, 'exr_recompress.py');

/** EXR compressions FFmpeg cannot write; frames are recompressed with OpenEXR afterwards. */
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

/** Recompress every .exr in `dir`. onProgress(n) after each file. */
export function recompressFolder(dir, compression, level, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const proc = spawn(venvPython(), [SCRIPT, compression, String(level), dir], { windowsHide: true });
    // The script runs worker processes; on cancel stop the whole tree, not just the parent.
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
        const m = buf.slice(0, i).match(/^done (\d+)/);
        buf = buf.slice(i + 1);
        if (m && onProgress) onProgress(Number(m[1]));
      }
    });
    proc.stderr.on('data', (d) => (stderr += d));
    let failure = null;
    proc.on('error', (err) => {
      failure = err;
      if (proc.pid === undefined) reject(err);
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(new Error('cancelled'));
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`EXR recompression failed: ${stderr.trim().split('\n').pop()}`));
    });
  });
}
