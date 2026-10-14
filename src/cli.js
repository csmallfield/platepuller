#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseXmeml, readVideoClips, writeProcessedXml } from './xmeml.js';
import { probeSource } from './probe.js';
import { buildJobs, findCollisions } from './plan.js';
import { encodeJob, FRAME_MATCH } from './encode.js';
import { VARIABLES, validateTemplate } from './template.js';
import { writeBuiltinLut } from './applelog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_PRESETS = JSON.parse(fs.readFileSync(path.join(here, 'presets.json'), 'utf8'));
const CONVERSIONS = { 'applelog-rec709': 'Apple Log -> Rec.709 (built-in, approximate)' };

const DEFAULTS = {
  template: '{editSource}/{clipName}/{clipName}_{colorSpace}_{version}_{preset}',
  preset: ['prores422hq'],
  version: 'v001',
  handles: 12,
  string: '',
  jobs: 2,
  exposure: 0.6,
  frameMatch: 'nearest',
};

const HELP = `platepuller <edit.xml> [options]

Publishes every video clip of a Premiere XML (Final Cut Pro 7 XML) edit as its own
file with handles, then writes <editSource>_processed.xml relinked to the new files.

Options
  -o, --out <dir>          Output root (default: "publish" next to the XML)
  -t, --template <tpl>     Path + name template, "/" for folders. Extension comes from the preset.
                           default: ${DEFAULTS.template}
  -p, --preset <name>      Compression preset, repeatable (default: ${DEFAULTS.preset[0]})
      --version <v>        {version} value (default: ${DEFAULTS.version})
      --handles <n>        Handle length in frames (default: ${DEFAULTS.handles})
      --string <s>         {string} value
      --color-space <s>    {colorSpace} label (default: LOG, or REC709 when converting)
      --convert <name>     Built-in colour conversion: ${Object.keys(CONVERSIONS).join(', ')}
      --lut <file.cube>    Apply this 3D LUT (e.g. Apple's official Apple Log to Rec709 LUT)
      --exposure <x>       Exposure for --convert applelog-rec709 (default: ${DEFAULTS.exposure})
      --frame-match <m>    How edit frames map to source samples: ${Object.keys(FRAME_MATCH).join(' | ')}
                           (default: nearest, which matches Premiere's time-based conform)
      --config <job.json>  Read options from a JSON file (CLI flags win)
      --presets <file>     Extra presets JSON, merged over the built-in ones
  -j, --jobs <n>           Parallel encodes (default: ${DEFAULTS.jobs})
      --include-disabled   Also publish disabled clips
      --overwrite          Replace existing outputs
      --skip-existing      Keep existing outputs, still list them in the XML
      --dry-run            Show the plan, write nothing
      --list-presets       List presets and exit
      --list-variables     List template variables and exit
  -h, --help

Example
  platepuller edit.xml --version v002 --preset prores422hq --preset h264 \\
    --convert applelog-rec709 --template "{editSource}/{clipName}/{clipName}_{colorSpace}_{version}_{preset}"
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      template: { type: 'string', short: 't' },
      preset: { type: 'string', short: 'p', multiple: true },
      version: { type: 'string' },
      handles: { type: 'string' },
      string: { type: 'string' },
      'color-space': { type: 'string' },
      convert: { type: 'string' },
      lut: { type: 'string' },
      exposure: { type: 'string' },
      'frame-match': { type: 'string' },
      config: { type: 'string' },
      presets: { type: 'string' },
      jobs: { type: 'string', short: 'j' },
      'include-disabled': { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'skip-existing': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'list-presets': { type: 'boolean' },
      'list-variables': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values, positionals };
}

const camel = (k) => k.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function resolveOptions(values, positionals) {
  const fromConfig = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {};
  const cli = Object.fromEntries(Object.entries(values).map(([k, v]) => [camel(k), v]));
  const o = { ...DEFAULTS, ...fromConfig, ...Object.fromEntries(Object.entries(cli).filter(([, v]) => v !== undefined)) };
  o.xml = positionals[0] ?? fromConfig.xml;
  if (typeof o.preset === 'string') o.preset = [o.preset];
  o.handles = Number(o.handles);
  o.jobs = Math.max(1, Number(o.jobs));
  o.exposure = Number(o.exposure);
  if (!Number.isInteger(o.handles) || o.handles < 0) throw new Error('--handles must be a whole number of frames');
  if (o.convert && !CONVERSIONS[o.convert]) throw new Error(`Unknown --convert "${o.convert}". Available: ${Object.keys(CONVERSIONS).join(', ')}`);
  if (o.convert && o.lut) throw new Error('Use either --convert or --lut, not both');
  if (o.lut && !fs.existsSync(o.lut)) throw new Error(`LUT not found: ${o.lut}`);
  o.converting = Boolean(o.convert || o.lut);
  o.colorSpace ??= o.converting ? 'REC709' : 'LOG';
  if (!FRAME_MATCH[o.frameMatch]) throw new Error(`Unknown --frame-match "${o.frameMatch}". Use ${Object.keys(FRAME_MATCH).join(', ')}`);
  if (o.overwrite && o.skipExisting) throw new Error('Use either --overwrite or --skip-existing');
  return o;
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
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
  const header = ['shot', 'clipName', 'preset', 'status', 'source', 'clipIn', 'clipOut', 'headHandle', 'tailHandle', 'publishedFirstFrame', 'publishedLastFrame', 'frames', 'output', 'warnings'];
  const rows = jobs.map((j) => [
    j.shot, j.clip.name, j.presetName, j.status, j.clip.file.path, j.clip.in, j.clip.out - 1,
    j.range.head, j.range.tail, j.range.start, j.range.end - 1, j.range.frames, j.outPath,
    [...j.warnings, j.error].filter(Boolean).join('; '),
  ]);
  fs.writeFileSync(file, [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
}

async function main() {
  const { values, positionals } = parse(process.argv.slice(2));
  if (values.help) return console.log(HELP);

  let presets = { ...BUILTIN_PRESETS };
  if (values.presets) presets = { ...presets, ...JSON.parse(fs.readFileSync(values.presets, 'utf8')) };
  if (values['list-presets']) {
    for (const [k, p] of Object.entries(presets)) console.log(`${k.padEnd(14)} .${p.ext.padEnd(4)} ${p.description ?? ''}`);
    return;
  }
  if (values['list-variables']) {
    for (const [k, d] of Object.entries(VARIABLES)) console.log(`{${k}}`.padEnd(22) + d);
    return;
  }

  const o = resolveOptions(values, positionals);
  if (!o.xml) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  validateTemplate(o.template);
  for (const p of o.preset) if (!presets[p]) throw new Error(`Unknown preset "${p}". Run --list-presets.`);

  const xmlText = fs.readFileSync(o.xml, 'utf8');
  const editSource = path.parse(o.xml).name;
  o.out = path.resolve(o.out ?? path.join(path.dirname(o.xml), 'publish'));

  const edit = readVideoClips(parseXmeml(xmlText));
  for (const s of edit.skipped) console.warn(`skip  ${s.name}: ${s.reason}`);
  const disabled = edit.clips.filter((c) => !c.enabled);
  if (!o.includeDisabled) {
    for (const c of disabled) console.warn(`skip  ${c.name}: disabled on the timeline (use --include-disabled)`);
    edit.clips = edit.clips.filter((c) => c.enabled);
  }
  if (!edit.clips.length) throw new Error('No video clips with media found in the XML.');

  const missing = [...new Set(edit.clips.map((c) => c.file.path))].filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`Source media not found:\n  ${missing.join('\n  ')}`);

  console.log(`${edit.sequenceName}: ${edit.clips.length} clips, probing sources...`);
  const probes = new Map();
  for (const p of new Set(edit.clips.map((c) => c.file.path))) probes.set(p, await probeSource(p));

  const jobs = buildJobs({ edit, probes, presets, presetNames: o.preset, opts: o, editSource });
  const collisions = findCollisions(jobs);
  if (collisions.length) {
    const lines = collisions.map((list) => `  ${list[0].outPath}  <- ${list.map((j) => `${j.clip.name}/${j.presetName}`).join(', ')}`);
    throw new Error(`The template gives several clips the same output file:\n${lines.join('\n')}\nAdd {shot} or {preset} to the template.`);
  }

  const lut = o.lut ? path.resolve(o.lut) : o.convert === 'applelog-rec709' ? writeBuiltinLut(o.exposure) : null;
  const colorSpaceOut = o.converting ? 'rec709' : 'source';

  console.log(`output  ${o.out}`);
  console.log(`handles ${o.handles}  frame match ${o.frameMatch}  presets ${o.preset.join(', ')}  colour ${o.converting ? (o.lut ? `LUT ${o.lut}` : CONVERSIONS[o.convert]) : 'unchanged'}\n`);
  for (const j of jobs) {
    const exists = fs.existsSync(j.outPath);
    j.status = exists && o.skipExisting ? 'kept' : exists && !o.overwrite ? 'exists' : 'todo';
    const rel = path.relative(o.out, j.outPath);
    console.log(`${j.shot} ${j.clip.name.padEnd(8)} ${String(j.range.start).padStart(5)}-${String(j.range.end - 1).padEnd(5)} (${j.range.head}+${j.clip.out - j.clip.in}+${j.range.tail})  ${rel}${j.status !== 'todo' ? `  [${j.status}]` : ''}`);
    for (const w of j.warnings) console.log(`      ! ${w}`);
  }

  const blocked = jobs.filter((j) => j.status === 'exists');
  if (blocked.length) throw new Error(`${blocked.length} output(s) already exist. Use --overwrite or --skip-existing.`);
  if (o.dryRun) return console.log('\nDry run: nothing written.');

  console.log('');
  const todo = jobs.filter((j) => j.status === 'todo');
  let done = 0;
  await pool(todo, o.jobs, async (j) => {
    const t0 = Date.now();
    try {
      await encodeJob(j, { lut, colorSpaceOut, frameMatch: o.frameMatch });
      j.status = 'ok';
    } catch (err) {
      j.status = 'failed';
      j.error = err.message.split('\n')[0];
      console.error(`FAILED ${j.clip.name} ${j.presetName}: ${err.message}`);
    }
    done++;
    console.log(`[${done}/${todo.length}] ${j.status.padEnd(6)} ${j.clip.name} ${j.presetName}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });

  fs.mkdirSync(o.out, { recursive: true });
  const reportPath = path.join(o.out, `${editSource}_report.csv`);
  writeReport(reportPath, jobs);
  console.log(`\nreport  ${reportPath}`);

  for (const presetName of o.preset) {
    const forPreset = jobs.filter((j) => j.presetName === presetName);
    if (forPreset.some((j) => j.status === 'failed')) {
      console.warn(`No processed XML for ${presetName}: some clips failed.`);
      continue;
    }
    const published = forPreset.map((j) => ({
      clip: j.clip,
      outPath: j.outPath,
      outFrames: j.range.frames,
      headHandle: j.range.head,
      timecodeFrame: (j.clip.file.timecodeFrame ?? 0) + j.range.start,
      width: j.probe.width,
      height: j.probe.height,
      audioChannels: j.probe.audio?.channels ?? 0,
      audioSampleRate: j.probe.audio?.sampleRate,
    }));
    const suffix = o.preset.length > 1 ? `_${presetName}_processed` : '_processed';
    const xmlOut = path.join(o.out, `${editSource}${suffix}.xml`);
    fs.writeFileSync(xmlOut, writeProcessedXml(xmlText, published, { sequenceSuffix: suffix }));
    console.log(`xml     ${xmlOut}`);
  }
  if (jobs.some((j) => j.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
