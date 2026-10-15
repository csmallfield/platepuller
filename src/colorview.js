// The ACES 1.0 SDR-video view (as in Maya), baked from OpenColorIO into LUTs by
// color_bake.py. Baked once per source colour space and exposure, then cached.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { venvPython } from './openexr.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'color_bake.py');
const CACHE = path.join(os.tmpdir(), 'platepuller-luts');
const VERSION = 'aces13-sdr709-v1'; // bump when color_bake.py changes its output

let status = null;

/** { available, reason } — OpenColorIO in the platepuller Python environment. */
export function ocioStatus() {
  if (status) return status;
  const python = venvPython();
  if (!fs.existsSync(python)) {
    status = { available: false, reason: 'The ACES Rec.709 view needs OpenColorIO. Run "npm run setup-exr" in the platepuller folder.' };
  } else {
    const r = spawnSync(python, [SCRIPT, '--check'], { encoding: 'utf8', windowsHide: true });
    status = r.status === 0
      ? { available: true }
      : { available: false, reason: 'The ACES Rec.709 view needs OpenColorIO. Run "npm run setup-exr" in the platepuller folder.' };
  }
  return status;
}

/** { lut3d, lut1d } for the view from `input` (acescg, lin_rec709, lin_rec2020, aces2065, applelog). */
export function bakeView(input, stops = 0) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = `${VERSION}_${input}_${stops >= 0 ? '+' : ''}${stops}`;
  const lut3d = path.join(CACHE, `${key}.cube`);
  const lut1d = path.join(CACHE, `${VERSION}_gamma24.cube`);
  if (fs.existsSync(lut3d) && fs.existsSync(lut1d)) return { lut3d, lut1d };
  const tmp3d = `${lut3d}.${process.pid}.tmp`;
  const tmp1d = `${lut1d}.${process.pid}.tmp`;
  const r = spawnSync(venvPython(), [SCRIPT, JSON.stringify({ input, stops, size: 65, out3d: tmp3d, out1d: tmp1d })], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`Could not bake the ACES view: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
  fs.renameSync(tmp3d, lut3d);
  fs.renameSync(tmp1d, lut1d);
  return { lut3d, lut1d };
}
