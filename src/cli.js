#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FRAME_MATCH } from './encode.js';
import { VARIABLES } from './template.js';
import { COLOR_MODES, DEFAULTS, SOURCE_SPACES, loadPresets, preparePublish, runPublish } from './publish.js';

const HELP = `platepuller <edit.xml | file | folder> [options]

With a Premiere XML (Final Cut Pro 7 XML): publishes every video clip of the edit as its
own file with handles, then writes <editSource>_processed.xml relinked to the new files.
With a movie file, one frame of an image sequence, or a folder: converts each movie and
image sequence found there.
Run "npm run ui" (or platepuller.cmd) for the graphical version.

Options
  -o, --out <dir>          Output root (default: "publish" next to the XML or file,
                           "<folder>_publish" next to a folder)
  -t, --template <tpl>     Path + name template, "/" for folders. Extension comes from the preset.
                           default: ${DEFAULTS.template}
                           files and folders: ${DEFAULTS.filesTemplate}
  -p, --preset <name>      Compression preset, repeatable (default: ${DEFAULTS.output.preset})
      --version <v>        {version} value (default: ${DEFAULTS.version})
      --handles <n>        Handle length in frames (default: ${DEFAULTS.handles})
      --string <s>         {string} value
      --color-space <s>    {colorSpace} label (default: LOG, or REC709 when converting)
      --convert <name>     Colour conversion: ${Object.keys(COLOR_MODES).filter((k) => !['none', 'lut'].includes(k)).join(', ')}
                           rec709 = ACES 1.0 SDR-video, as in Maya (needs "npm run setup-exr" once)
                           acescg = scene-linear ACEScg (EXR only)
      --source-space <s>   Source colour space: ${Object.keys(SOURCE_SPACES).join(', ')}
                           (default: auto, from the files: EXR headers, camera tags)
      --lut <file.cube>    Apply this 3D LUT (e.g. Apple's official Apple Log to Rec709 LUT)
      --exposure <stops>   Exposure for rec709 / acescg / applelog-rec709, in stops (default: 0)
      --scale <s>          Output size: full, half, quarter, or a width in pixels (default: full)
      --alpha              Add an alpha channel (png8, png16, exr16, exr32, prores4444)
      --exr-compression <c> EXR compression: zip16 (ZIP, default), zip1 (ZIPS), piz, dwaa, dwab, rle, none
                           (piz, dwaa and dwab need "npm run setup-exr" once)
      --dwa-level <n>      DWAA/DWAB compression level (default: 45)
      --start-frame <n>    Frame number of the first image of a sequence (default: ${DEFAULTS.startFrame})
  -r, --recursive          Files and folders: include subfolders
      --range <first-last> Files and folders, single source: frame range, e.g. 1001-1100
      --fps <n>            Files and folders: frame rate of image sequences (default: from the
                           files, else 24)
      --mirror             Files and folders: recreate the source folder structure in the output
      --frame-match <m>    How edit frames map to source samples: ${Object.keys(FRAME_MATCH).join(' | ')}
                           (default: nearest, which matches Premiere's time-based conform)
      --config <job.json>  Read options from a JSON file (CLI flags win)
      --presets <file>     Extra presets JSON, merged over the built-in ones
  -j, --jobs <n>           Clips encoded at once; each clip is decoded once for all outputs (default: ${DEFAULTS.jobs})
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

const OPTIONS = {
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
  scale: { type: 'string' },
  alpha: { type: 'boolean' },
  'exr-compression': { type: 'string' },
  'dwa-level': { type: 'string' },
  'start-frame': { type: 'string' },
  'frame-match': { type: 'string' },
  'source-space': { type: 'string' },
  recursive: { type: 'boolean', short: 'r' },
  range: { type: 'string' },
  fps: { type: 'string' },
  mirror: { type: 'boolean' },
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
};

const camel = (k) => k.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** CLI flags (+ optional --config file) -> publish settings. Every preset shares the colour options. */
function toSettings(values, positionals) {
  const fromConfig = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {};
  const cli = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [camel(k), v]));
  const o = { ...fromConfig, ...cli };
  if (o.convert && o.lut) throw new Error('Use either --convert or --lut, not both');
  const converts = [...Object.keys(COLOR_MODES).filter((k) => !['none', 'lut'].includes(k)), 'applelog-acescg'];
  if (o.convert && !converts.includes(o.convert)) throw new Error(`Unknown --convert "${o.convert}". Available: ${converts.join(', ')}`);
  let range = o.range;
  if (typeof range === 'string') {
    const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) throw new Error('--range must look like 1001-1100');
    range = { first: Number(m[1]), last: Number(m[2]) };
  }
  const scale = o.scale === undefined ? {} : /^\d+$/.test(o.scale) ? { scale: 'custom', width: Number(o.scale) } : { scale: o.scale };
  if (o.overwrite && o.skipExisting) throw new Error('Use either --overwrite or --skip-existing');
  if (o.outputs && o.preset) throw new Error('Use either "outputs" in the config file or --preset');

  const color = o.lut ? 'lut' : o.convert ?? 'none';
  const presets = [].concat(o.preset ?? DEFAULTS.output.preset);
  const input = positionals[0] ?? o.xml ?? o.input;
  const files = o.mode ? o.mode === 'files' : Boolean(input) && !/\.xml$/i.test(input);
  return {
    mode: files ? 'files' : 'xml',
    xml: files ? undefined : input,
    input: files ? input : undefined,
    recursive: Boolean(o.recursive),
    mirror: Boolean(o.mirror),
    range,
    fps: o.fps ?? '',
    sourceSpace: o.sourceSpace ?? 'auto',
    out: o.out,
    template: files ? DEFAULTS.template : o.template ?? DEFAULTS.template,
    filesTemplate: files ? o.template ?? o.filesTemplate ?? DEFAULTS.filesTemplate : DEFAULTS.filesTemplate,
    version: o.version ?? DEFAULTS.version,
    handles: o.handles ?? DEFAULTS.handles,
    string: o.string ?? DEFAULTS.string,
    jobs: o.jobs ?? DEFAULTS.jobs,
    frameMatch: o.frameMatch ?? DEFAULTS.frameMatch,
    includeDisabled: Boolean(o.includeDisabled),
    existing: o.overwrite ? 'overwrite' : o.skipExisting ? 'skip' : o.existing ?? 'stop',
    startFrame: o.startFrame ?? DEFAULTS.startFrame,
    outputs:
      o.outputs ??
      presets.map((preset) => ({
        preset,
        color,
        lut: o.lut,
        exposure: o.exposure ?? DEFAULTS.output.exposure,
        colorSpace: o.colorSpace,
        alpha: Boolean(o.alpha),
        exrCompression: o.exrCompression ?? DEFAULTS.output.exrCompression,
        dwaLevel: o.dwaLevel ?? DEFAULTS.output.dwaLevel,
        ...scale,
      })),
  };
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: OPTIONS });
  if (values.help) return console.log(HELP);
  const presets = loadPresets(values.presets);
  if (values['list-presets']) {
    for (const [k, p] of Object.entries(presets)) console.log(`${k.padEnd(18)} .${p.ext.padEnd(4)} ${p.description ?? ''}`);
    return;
  }
  if (values['list-variables']) {
    for (const [k, d] of Object.entries(VARIABLES)) console.log(`{${k}}`.padEnd(22) + d);
    return;
  }

  const settings = toSettings(values, positionals);
  if (!settings.xml && !settings.input) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  console.log(settings.mode === 'files' ? 'Scanning and probing sources...' : 'Reading edit and probing sources...');
  const plan = await preparePublish(settings, presets);
  for (const n of plan.notes) console.warn(n);
  if (plan.edit) {
    console.log(`${plan.edit.sequenceName}: ${plan.edit.clips.length} ${plan.mode === 'files' ? 'sources' : 'clips'} -> ${plan.out}`);
    const s = plan.settings;
    if (plan.mode === 'files') {
      for (const c of plan.edit.clips) {
        const seq = c.file.sequence;
        console.log(`  ${c.name}  ${seq ? `${seq.first}-${seq.last}` : `frames ${c.in}-${c.out - 1}`}  ${c.rate.timebase}${c.rate.ntsc ? '/1.001' : ''} fps  ${c.inputSpace ?? 'colour space unknown'}${c.detected && s.sourceSpace === 'auto' ? ` (${c.detected.from})` : ''}`);
      }
    } else console.log(`handles ${s.handles}  frame match ${s.frameMatch}`);
    plan.outputs.forEach((o, i) => console.log(`output ${i + 1}: ${o.preset}, colour ${o.color === 'lut' ? `LUT ${o.lut}` : o.color}, {colorSpace}=${o.colorSpace ?? 'from source'}, ${o.scale === "custom" ? `${o.width}px wide` : o.scale}${o.alpha ? ", alpha" : ""}`));
    console.log('');
  }
  for (const j of plan.jobs) {
    const rel = path.relative(plan.out, j.displayPath);
    console.log(`${j.shot} ${j.clip.name.padEnd(8)} ${String(j.range.start).padStart(5)}-${String(j.range.end - 1).padEnd(5)} (${j.range.head}+${j.clip.out - j.clip.in}+${j.range.tail})  ${rel}${j.status !== 'todo' ? `  [${j.status}]` : ''}`);
    if (j.output.index === 0) for (const w of j.warnings) console.log(`      ! ${w}`);
  }
  if (plan.errors.length) throw new Error(plan.errors.join('\n'));
  if (values['dry-run']) return console.log('\nDry run: nothing written.');
  console.log('');

  const names = (j) => `${j.clip.name} ${j.presetName}`;
  const { failed, cancelled } = await runPublish(plan, {
    onEvent(e) {
      if (e.type === 'job-done') {
        const j = plan.jobs[e.id];
        if (e.status === 'failed') console.error(`FAILED ${names(j)}: ${e.error}`);
        console.log(`[${e.done}/${e.total}] ${e.status.padEnd(6)} ${names(j)}  ${e.seconds.toFixed(1)}s`);
      } else if (e.type === 'file' && e.kind === 'report') console.log(`\nreport  ${e.path}`);
      else if (e.type === 'file' && e.kind === 'xml') console.log(`xml     ${e.path}`);
      else if (e.type === 'file' && e.kind === 'xml-skipped') console.warn(`No processed XML for output ${e.output + 1}: ${e.reason}.`);
    },
  });
  if (failed || cancelled) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
