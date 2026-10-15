// RGB colour space matrices from primaries, so no magic numbers are copied around.

const mul = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const mulVec = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function inv(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];

export const SPACES = {
  rec709: { primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: [0.3127, 0.329] },
  rec2020: { primaries: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: [0.3127, 0.329] },
  // ACEScg (AP1 primaries, ACES white point)
  acescg: { primaries: [[0.713, 0.293], [0.165, 0.83], [0.128, 0.044]], white: [0.32168, 0.33767] },
  // ACES2065-1 (AP0 primaries, ACES white point)
  aces2065: { primaries: [[0.7347, 0.2653], [0, 1], [0.0001, -0.077]], white: [0.32168, 0.33767] },
};

export function rgbToXyz({ primaries, white }) {
  const P = [0, 1, 2].map((c) => [0, 1, 2].map((r) => xyz(primaries[r])[c])); // columns = primaries
  const S = mulVec(inv(P), xyz(white));
  return P.map((row) => row.map((v, j) => v * S[j]));
}

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

function adapt(fromWhite, toWhite) {
  const s = mulVec(BRADFORD, xyz(fromWhite));
  const d = mulVec(BRADFORD, xyz(toWhite));
  const D = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return mul(inv(BRADFORD), mul(D, BRADFORD));
}

/** Linear RGB -> linear RGB matrix between two of SPACES, with Bradford white adaptation. */
export function conversionMatrix(from, to) {
  const a = SPACES[from];
  const b = SPACES[to];
  return mul(inv(rgbToXyz(b)), mul(adapt(a.white, b.white), rgbToXyz(a)));
}
