#!/usr/bin/env node
// Sets up optional OpenEXR support (DWAA / DWAB / PIZ compression): a private Python
// virtual environment in .venv with the packages from requirements-exr.txt.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, venvPython } from '../src/openexr.js';

const quiet = process.argv.includes('--quiet');
const log = (...a) => console.log(...a);

function findPython() {
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === '3') return [cmd, pre];
  }
  return null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

try {
  if (!fs.existsSync(venvPython())) {
    const py = findPython();
    if (!py) throw new Error('Python 3 was not found. Install it from https://www.python.org (or: winget install Python.Python.3.13), then run this again.');
    log('Creating .venv for OpenEXR support...');
    run(py[0], [...py[1], '-m', 'venv', path.join(ROOT, '.venv')]);
  }
  log('Installing OpenEXR packages...');
  run(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', path.join(ROOT, 'requirements-exr.txt')]);
  log('OpenEXR support ready: DWAA, DWAB and PIZ compression are available.');
} catch (err) {
  console.error(`OpenEXR setup skipped: ${err.message}`);
  process.exitCode = 1;
}
