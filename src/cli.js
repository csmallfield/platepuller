#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FRAME_MATCH } from './encode.js';
import { VARIABLES } from './template.js';
import { DEFAULTS, loadPresets, preparePublish, runPublish } from './publish.js';

const HELP = `platepuller <edit.xml> [options]

Publishes every video clip of a Premiere XML (Final Cut Pro 7 XML) edit as its own
file with handles, then writes <editSource>_processed.xml relinked to the new files.
Run "npm run ui" (or platepuller.cmd) for the graphical version.

Options
  -o, --out <dir>          Output root (default: "publish" next to the XML)
  -t, --template <tpl>     Path + name template, "/" for folders. Extension comes from the preset.
                           default: ${DEFAULTS.template}
  -p, --preset <name>      Compression preset, repeatable (default: ${DEFAULTS.output.preset})
      --version <v>        {version} value (default: ${DEFAULTS.version})
      --handles <n>        Handle length in frames (default: ${DEFAULTS.handles})
      --string <s>         {string} value
      --color-space <s>    {colorSpace} label (default: LOG, or REC709 when converting)
      --convert <name>     Built-in colour conversion: applelog-rec709
      --lut <file.cube>    Apply this 3D LUT (e.g. Apple's official Apple Log to Rec709 LUT)
      --exposure <stops>   Exposure for --convert applelog-rec709, in stops (default: 0 = neutral)
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
};

const camel = (k) => k.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** CLI flags (+ optional --config file) -> publish settings. Every preset shares the colour options. */
function toSettings(values, positionals) {
  const fromConfig = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {};
  const cli = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [camel(k), v]));
  const o = { ...fromConfig, ...cli };
  if (o.convert && o.lut) throw new Error('Use either --convert or --lut, not both');
  if (o.convert && o.convert !== 'applelog-rec709') throw new Error(`Unknown --convert "${o.convert}". Available: applelog-rec709`);
  if (o.overwrite && o.skipExisting) throw new Error('Use either --overwrite or --skip-existing');
  if (o.outputs && o.preset) throw new Error('Use either "outputs" in the config file or --preset');

  const color = o.lut ? 'lut' : o.convert ? 'applelog-rec709' : 'none';
  const presets = [].concat(o.preset ?? DEFAULTS.output.preset);
  return {
    xml: positionals[0] ?? o.xml,
    out: o.out,
    template: o.template ?? DEFAULTS.template,
    version: o.version ?? DEFAULTS.version,
    handles: o.handles ?? DEFAULTS.handles,
    string: o.string ?? DEFAULTS.string,
    jobs: o.jobs ?? DEFAULTS.jobs,
    frameMatch: o.frameMatch ?? DEFAULTS.frameMatch,
    includeDisabled: Boolean(o.includeDisabled),
    existing: o.overwrite ? 'overwrite' : o.skipExisting ? 'skip' : o.existing ?? 'stop',
    outputs: o.outputs ?? presets.map((preset) => ({ preset, color, lut: o.lut, exposure: o.exposure ?? DEFAULTS.output.exposure, colorSpace: o.colorSpace })),
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
  if (!settings.xml) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  console.log('Reading edit and probing sources...');
  const plan = await preparePublish(settings, presets);
  for (const n of plan.notes) console.warn(n);
  if (plan.edit) {
    console.log(`${plan.edit.sequenceName}: ${plan.edit.clips.length} clips -> ${plan.out}`);
    const s = plan.settings;
    console.log(`handles ${s.handles}  frame match ${s.frameMatch}`);
    plan.outputs.forEach((o, i) => console.log(`output ${i + 1}: ${o.preset}, colour ${o.color === 'lut' ? `LUT ${o.lut}` : o.color}, {colorSpace}=${o.colorSpace}`));
    console.log('');
  }
  for (const j of plan.jobs) {
    const rel = path.relative(plan.out, j.outPath);
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
