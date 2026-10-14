// The publish pipeline shared by the CLI and the UI:
// prepare (read XML, probe sources, plan jobs) -> run (encode, write report + processed XML).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXmeml, readVideoClips, writeProcessedXml } from './xmeml.js';
import { probeSource } from './probe.js';
import { buildJobs, findCollisions } from './plan.js';
import { encodeJob, outputExists, FRAME_MATCH } from './encode.js';
import { validateTemplate } from './template.js';
import { writeBuiltinLut, writeLinearLut } from './applelog.js';
import { conversionMatrix } from './colormath.js';
import { OPENEXR_COMPRESSION, openexrStatus } from './openexr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_PRESETS = JSON.parse(fs.readFileSync(path.join(here, 'presets.json'), 'utf8'));

export const COLOR_MODES = {
  none: 'No conversion (keep source)',
  'applelog-rec709': 'Apple Log → Rec.709 (built-in, approximate)',
  'applelog-acescg': 'Apple Log → ACEScg (scene-linear, EXR only)',
  lut: 'Custom 3D LUT (.cube)',
};
const COLOR_SPACE_LABEL = { none: 'LOG', 'applelog-rec709': 'REC709', 'applelog-acescg': 'ACESCG', lut: 'REC709' };

export const SCALES = { full: 'Full', half: 'Half', quarter: 'Quarter', custom: 'Custom width' };

export const EXR_COMPRESSION = {
  zip16: 'ZIP (16 lines, lossless)',
  zip1: 'ZIPS (1 line, lossless)',
  piz: 'PIZ (lossless, wavelet)',
  dwaa: 'DWAA (lossy, small files)',
  dwab: 'DWAB (lossy, 256-line blocks)',
  rle: 'RLE (lossless)',
  none: 'None',
};

export const DEFAULTS = {
  template: '{editSource}/{clipName}/{clipName}_{colorSpace}_{version}_{preset}',
  version: 'v001',
  handles: 12,
  string: '',
  jobs: 2,
  frameMatch: 'nearest',
  existing: 'stop', // stop | overwrite | skip
  includeDisabled: false,
  startFrame: 1001, // number of the first frame (first handle frame) of image sequences
  output: {
    preset: 'prores422hq',
    color: 'none',
    exposure: 0, // stops
    lut: '',
    colorSpace: '',
    scale: 'full',
    width: 1920, // for scale: 'custom'
    alpha: false,
    exrCompression: 'zip16',
    dwaLevel: 45, // DWAA/DWAB compression level; 45 is the OpenEXR default
  },
};

export function loadPresets(extraFile) {
  const extra = extraFile ? JSON.parse(fs.readFileSync(extraFile, 'utf8')) : {};
  return { ...BUILTIN_PRESETS, ...extra };
}

/** Fill defaults and check one output definition. Returns { output, errors }. */
export function normalizeOutput(raw, presets) {
  const o = { ...DEFAULTS.output, ...raw };
  o.exposure = Number(o.exposure);
  o.width = Number(o.width);
  o.alpha = Boolean(o.alpha);
  const preset = presets[o.preset];
  const errors = [];
  if (!preset) errors.push(`Unknown preset "${o.preset}"`);
  if (!COLOR_MODES[o.color]) errors.push(`Unknown colour mode "${o.color}"`);
  if (o.color === 'lut' && !o.lut) errors.push('Choose a LUT file');
  else if (o.color === 'lut' && !fs.existsSync(o.lut)) errors.push(`LUT not found: ${o.lut}`);
  if (o.color.startsWith('applelog-') && !(Math.abs(o.exposure) <= 6)) errors.push('Exposure must be between -6 and +6 stops');
  if (o.color === 'applelog-acescg' && preset && preset.space !== 'float') {
    errors.push('ACEScg is scene-linear and needs a float format: choose exr16 or exr32');
  }
  if (!SCALES[o.scale]) errors.push(`Unknown resolution "${o.scale}"`);
  if (o.scale === 'custom' && !(Number.isInteger(o.width) && o.width >= 16 && o.width <= 16384)) {
    errors.push('Custom width must be a whole number of pixels (16 to 16384)');
  }
  if (o.alpha && preset && !preset.alphaPixFmt) errors.push(`${o.preset} has no alpha channel option`);
  if (preset?.ext === 'exr') {
    o.dwaLevel = Number(o.dwaLevel);
    if (!EXR_COMPRESSION[o.exrCompression]) errors.push(`Unknown EXR compression "${o.exrCompression}"`);
    else if (OPENEXR_COMPRESSION.has(o.exrCompression) && !openexrStatus().available) errors.push(openexrStatus().reason);
    if (o.exrCompression.startsWith('dwa') && !(o.dwaLevel > 0 && o.dwaLevel <= 1000)) errors.push('DWA level must be between 1 and 1000 (45 is the default)');
  }
  if (!preset || !preset.alphaPixFmt) o.alpha = false;
  o.colorSpace = String(o.colorSpace ?? '').trim() || COLOR_SPACE_LABEL[o.color] || 'LOG';
  return { output: o, errors };
}

/**
 * Read the edit, probe sources and plan every job. Never throws for problems the user
 * can fix; they come back in `errors` so a UI can show them next to the inputs.
 */
export async function preparePublish(settings, presets = BUILTIN_PRESETS) {
  const s = { ...DEFAULTS, ...settings };
  s.handles = Number(s.handles);
  s.jobs = Math.max(1, Number(s.jobs) || 1);
  s.startFrame = Number(s.startFrame);
  const errors = [];
  const notes = [];

  if (!Number.isInteger(s.handles) || s.handles < 0) errors.push('Handles must be a whole number of frames');
  if (!FRAME_MATCH[s.frameMatch]) errors.push(`Unknown frame match "${s.frameMatch}"`);
  if (!Number.isInteger(s.startFrame) || s.startFrame < 0) errors.push('Sequence start frame must be a whole number, 0 or more');
  let templateOk = true;
  try {
    validateTemplate(s.template);
  } catch (err) {
    templateOk = false;
    errors.push(err.message);
  }
  const outputs = (s.outputs?.length ? s.outputs : [DEFAULTS.output]).map((raw, i) => {
    const { output, errors: e } = normalizeOutput(raw, presets);
    errors.push(...e.map((m) => `Output ${i + 1}: ${m}`));
    return { ...output, index: i };
  });

  const result = { settings: s, outputs, errors, notes, jobs: [], edit: null };
  if (!s.xml) {
    errors.push('Choose an edit XML');
    return result;
  }
  if (!fs.existsSync(s.xml)) {
    errors.push(`XML not found: ${s.xml}`);
    return result;
  }

  let edit;
  const xmlText = fs.readFileSync(s.xml, 'utf8');
  try {
    edit = readVideoClips(parseXmeml(xmlText));
  } catch (err) {
    errors.push(`Could not read the XML: ${err.message}`);
    return result;
  }
  result.xmlText = xmlText;
  result.editSource = path.parse(s.xml).name;
  result.out = path.resolve(s.out || path.join(path.dirname(s.xml), 'publish'));
  for (const k of edit.skipped) notes.push(`Skipped ${k.name}: ${k.reason}`);
  for (const c of edit.clips.filter((c) => !c.enabled)) {
    notes.push(s.includeDisabled ? `Including disabled clip ${c.name}` : `Skipped ${c.name}: disabled on the timeline`);
  }
  if (!s.includeDisabled) edit.clips = edit.clips.filter((c) => c.enabled);
  result.edit = edit;
  if (!edit.clips.length) {
    errors.push('No video clips with media found in the XML');
    return result;
  }

  const sources = [...new Set(edit.clips.map((c) => c.file.path))];
  const missing = sources.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    errors.push(`Source media not found:\n${missing.join('\n')}`);
    return result;
  }
  const probes = new Map();
  for (const p of sources) {
    try {
      probes.set(p, await probeSource(p));
    } catch (err) {
      errors.push(`Could not read ${p}: ${err.message.split('\n')[0]}`);
    }
  }
  if (probes.size < sources.length || !templateOk) return result;

  const validOutputs = outputs.filter((o) => presets[o.preset]);
  result.jobs = buildJobs({ edit, probes, presets, outputs: validOutputs, opts: { ...s, out: result.out }, editSource: result.editSource });
  result.jobs.forEach((j, i) => {
    j.id = i;
    const exists = outputExists(j);
    j.exists = exists;
    j.status = exists && s.existing === 'skip' ? 'kept' : exists && s.existing !== 'overwrite' ? 'exists' : 'todo';
  });

  // One message per kind of clash, not per file.
  const clashes = new Map();
  for (const list of findCollisions(result.jobs)) {
    const outs = [...new Set(list.map((j) => j.output.index + 1))];
    const key = outs.length > 1 ? `outputs ${outs.join(' and ')}` : `clips in output ${outs[0]}`;
    if (!clashes.has(key)) clashes.set(key, []);
    clashes.get(key).push(path.relative(result.out, list[0].outPath));
  }
  for (const [key, files] of clashes) {
    const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
    const fix = key.startsWith('outputs')
      ? 'Pick different formats or colour space labels, or add {preset} / {colorSpace} to the naming template.'
      : 'Add {shot} or {clipName} to the naming template.';
    errors.push(`The naming gives ${key} the same file names (${files[0]}${more}). ${fix}`);
  }
  const blocked = result.jobs.filter((j) => j.status === 'exists').length;
  if (blocked) errors.push(`${blocked} output file(s) already exist. Choose to overwrite or skip existing files.`);
  return result;
}

async function pool(items, size, fn, signal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReport(file, jobs) {
  const header = [
    'shot', 'clipName', 'output', 'preset', 'colorSpace', 'resolution', 'status', 'source', 'clipIn', 'clipOut', 'headHandle', 'tailHandle',
    'publishedFirstFrame', 'publishedLastFrame', 'frames', 'sequenceFirstFrame', 'sequenceLastFrame', 'file', 'warnings',
  ];
  const rows = jobs.map((j) => [
    j.shot, j.clip.name, j.output.index + 1, j.presetName, j.output.colorSpace, `${j.size.width}x${j.size.height}`, j.status, j.clip.file.path,
    j.clip.in, j.clip.out - 1, j.range.head, j.range.tail, j.range.start, j.range.end - 1, j.range.frames,
    j.seq ? j.seq.start : '', j.seq ? j.seq.start + j.range.frames - 1 : '', j.displayPath,
    [...j.warnings, j.error].filter(Boolean).join('; '),
  ]);
  fs.writeFileSync(file, [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
}

/** What the encoder needs for an output's colour mode: LUT files and matrices. */
export function colorResources(o) {
  switch (o.color) {
    case 'applelog-rec709':
      return { mode: o.color, lut3d: writeBuiltinLut(o.exposure), display: 'rec709' };
    case 'lut':
      return { mode: o.color, lut3d: path.resolve(o.lut), display: 'rec709' };
    case 'applelog-acescg':
      return { mode: o.color, lut1d: writeLinearLut(o.exposure), matrix: conversionMatrix('rec2020', 'acescg') };
    default:
      return { mode: 'none' };
  }
}

/** File name suffix for each output's processed XML: "_processed" or "_<preset>_<colorSpace>_processed". */
export function processedSuffixes(outputs) {
  if (outputs.length === 1) return ['_processed'];
  const seen = new Map();
  return outputs.map((o) => {
    let base = `_${o.preset}_${o.colorSpace}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) base += `_${n}`;
    return `${base}_processed`;
  });
}

/**
 * Encode every job of a prepared publish. `onEvent` receives
 * { type: 'start' | 'job-start' | 'job-progress' | 'job-done' | 'file' | 'done', ... }.
 */
export async function runPublish(prepared, { onEvent = () => {}, signal } = {}) {
  if (prepared.errors.length) throw new Error(prepared.errors.join('\n'));
  const { settings: s, jobs, outputs, out, editSource, xmlText } = prepared;

  const colors = outputs.map(colorResources);
  const todo = jobs.filter((j) => j.status === 'todo');
  onEvent({ type: 'start', total: todo.length, out });

  let done = 0;
  await pool(
    todo,
    s.jobs,
    async (j) => {
      const t0 = Date.now();
      j.status = 'running';
      onEvent({ type: 'job-start', id: j.id });
      try {
        await encodeJob(j, {
          color: colors[j.output.index],
          frameMatch: s.frameMatch,
          signal,
          onProgress: (frame) => onEvent({ type: 'job-progress', id: j.id, frame, frames: j.range.frames }),
        });
        j.status = 'ok';
      } catch (err) {
        j.status = signal?.aborted ? 'cancelled' : 'failed';
        if (j.status === 'failed') j.error = err.message.split('\n')[0];
      }
      done++;
      onEvent({ type: 'job-done', id: j.id, status: j.status, error: j.error, seconds: (Date.now() - t0) / 1000, done, total: todo.length });
    },
    signal,
  );
  for (const j of todo) {
    if (j.status !== 'todo') continue;
    j.status = 'cancelled';
    onEvent({ type: 'job-skipped', id: j.id, status: 'cancelled' });
  }

  fs.mkdirSync(out, { recursive: true });
  const reportPath = path.join(out, `${editSource}_report.csv`);
  writeReport(reportPath, jobs);
  onEvent({ type: 'file', kind: 'report', path: reportPath });

  const suffixes = processedSuffixes(outputs);
  outputs.forEach((o, i) => {
    const forOutput = jobs.filter((j) => j.output.index === o.index);
    if (!forOutput.length) return;
    if (forOutput[0].preset.kind === 'sequence') {
      onEvent({ type: 'file', kind: 'xml-skipped', output: i, reason: 'image sequences are not relinked in an XML' });
      return;
    }
    if (forOutput.some((j) => !['ok', 'kept'].includes(j.status))) {
      onEvent({ type: 'file', kind: 'xml-skipped', output: i, reason: 'not every clip was published' });
      return;
    }
    const published = forOutput.map((j) => ({
      clip: j.clip,
      outPath: j.outPath,
      outFrames: j.range.frames,
      headHandle: j.range.head,
      timecodeFrame: (j.clip.file.timecodeFrame ?? 0) + j.range.start,
      width: j.size.width,
      height: j.size.height,
      audioChannels: j.probe.audio?.channels ?? 0,
      audioSampleRate: j.probe.audio?.sampleRate,
    }));
    const xmlOut = path.join(out, `${editSource}${suffixes[i]}.xml`);
    fs.writeFileSync(xmlOut, writeProcessedXml(xmlText, published, { sequenceSuffix: suffixes[i] }));
    onEvent({ type: 'file', kind: 'xml', output: i, path: xmlOut });
  });

  const failed = jobs.filter((j) => j.status === 'failed').length;
  const cancelled = jobs.filter((j) => j.status === 'cancelled').length;
  onEvent({ type: 'done', failed, cancelled, out });
  return { failed, cancelled };
}
