// Built-in Apple Log -> Rec.709 transform, written as a .cube LUT.
//
// This is an approximate technical transform, not Apple's official LUT:
//   Apple Log decode (Apple Log Profile white paper) -> scene-linear Rec.2020
//   -> Rec.709 gamut -> filmic tone curve (Narkowicz ACES fit) -> BT.1886 (gamma 2.4) encode.
// For a matched look, pass Apple's official "Apple Log to Rec.709" .cube with --lut instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const R0 = -0.05641088;
const Rt = 0.01;
const c = 47.28711236;
const b = 0.00964052;
const gamma = 0.08550479;
const beta = 0.69336945;
const Pt = c * (Rt - R0) ** 2;

export function appleLogToLinear(P) {
  if (P >= Pt) return 2 ** ((P - beta) / gamma) - b;
  if (P >= 0) return Math.sqrt(P / c) + R0;
  return R0;
}

const REC2020_TO_REC709 = [
  [1.660491, -0.587641, -0.07285],
  [-0.124551, 1.1329, -0.008349],
  [-0.018151, -0.100579, 1.11873],
];

// The Narkowicz curve expects scene-linear input pre-scaled by 0.6; with it, 18% grey
// lands at ~44% display code value. That is the neutral point, i.e. 0 stops.
const CURVE_INPUT_SCALE = 0.6;

function toneMap(x) {
  const v = Math.max(0, x * CURVE_INPUT_SCALE);
  return Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
}

/** `stops`: exposure adjustment in stops, 0 = neutral, +1 = twice as bright. */
export function appleLogToRec709(rgb, stops = 0) {
  const gain = 2 ** stops;
  const lin = rgb.map(appleLogToLinear);
  return REC2020_TO_REC709.map((row) => {
    const v = (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) * gain;
    return toneMap(v) ** (1 / 2.4);
  });
}

export function buildCube(size = 33, stops = 0) {
  const lines = [
    'TITLE "Apple Log to Rec709 (platepuller approximate)"',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const n = size - 1;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const out = appleLogToRec709([ri / n, gi / n, bi / n], stops);
        lines.push(out.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function writeBuiltinLut(stops = 0) {
  const file = path.join(os.tmpdir(), `platepuller_applelog_rec709_${stops >= 0 ? '+' : ''}${stops}stops.cube`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buildCube(33, stops));
  return file;
}
