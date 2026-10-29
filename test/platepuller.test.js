import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseXmeml, readVideoClips, writeProcessedXml, child, text,
  pathFromPathurl, pathurlFromPath, framesToTimecode, ticksForFrames,
} from '../src/xmeml.js';
import { renderTemplate, validateTemplate } from '../src/template.js';
import { handleRange, buildJobs, findCollisions, outputSize } from '../src/plan.js';
import { framesAtRate } from '../src/probe.js';
import { appleLogToLinear, appleLogToRec709, buildLinear1D } from '../src/applelog.js';
import { conversionMatrix } from '../src/colormath.js';
import { normalizeOutput, BUILTIN_PRESETS } from '../src/publish.js';
import { imageFilters, clipArgs } from '../src/encode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixture.xml'), 'utf8');
const rate24 = { timebase: 24, ntsc: false };

test('reads video clips in timeline order with their source file', () => {
  const edit = readVideoClips(parseXmeml(fixture));
  assert.equal(edit.sequenceName, 'edit_v1');
  assert.deepEqual(edit.clips.map((c) => c.name), ['1A', '1B', '1C']);
  const [a, b, c] = edit.clips;
  assert.equal(a.file.name, 'TAKE_01.MOV');
  assert.equal(b.file.path, a.file.path, 'second use of the take resolves the shared file definition');
  assert.equal(c.enabled, false);
  assert.equal(a.file.timecodeFrame, 86400);
  assert.equal(a.linkedAudio.length, 1);
});

test('pathurl round trip', () => {
  const p = pathFromPathurl('file://localhost/D%3a/footage/day%201/TAKE_01.MOV');
  assert.equal(p.replace(/\\/g, '/'), 'D:/footage/day 1/TAKE_01.MOV');
  assert.equal(pathurlFromPath('D:\\footage\\day 1\\TAKE_01.MOV'), 'file://localhost/D%3a/footage/day%201/TAKE_01.MOV');
});

test('timecode and ticks', () => {
  assert.equal(framesToTimecode(86400 + 5, rate24), '01:00:00:05');
  assert.equal(framesToTimecode(1800, { timebase: 30, ntsc: true }, true), '00:01:00;02');
  assert.equal(ticksForFrames(247, rate24), 2614248000000);
});

test('handles are clamped to the media', () => {
  const clip = { in: 5, out: 25, file: { duration: 100 } };
  assert.deepEqual(handleRange(clip, 12, 100), { head: 5, tail: 12, start: 0, end: 37, frames: 37 });
  const tailClip = { in: 90, out: 98, file: { duration: 100 } };
  assert.deepEqual(handleRange(tailClip, 12, 100), { head: 12, tail: 2, start: 78, end: 100, frames: 22 });
});

test('templates', () => {
  const vars = { editSource: 'edit v1', clipName: '1A', colorSpace: 'LOG', version: 'v001', preset: 'h264', string: '' };
  assert.deepEqual(renderTemplate('{editSource}/<clipName>/{clipName}_{colorSpace}_{string}_{version}_{preset}', vars), [
    'edit_v1', '1A', '1A_LOG_v001_h264',
  ]);
  assert.throws(() => validateTemplate('{clipname}'), /Unknown template variable/);
  assert.throws(() => validateTemplate('{clipName}/{versi'), /unclosed variable/);
  assert.throws(() => validateTemplate(' / '), /empty/);
});

test('template collisions are reported', () => {
  const edit = readVideoClips(parseXmeml(fixture));
  const probes = new Map();
  const presets = { h264: { ext: 'mp4' } };
  const opts = { handles: 12, template: '{sourceFilename}_{preset}', out: 'out', version: 'v1', string: '' };
  const jobs = buildJobs({ edit, probes, presets, outputs: [{ preset: 'h264', colorSpace: 'LOG', index: 0 }], opts, editSource: 'edit_v1' });
  assert.equal(findCollisions(jobs).length, 1);
  const unique = buildJobs({ edit, probes, presets, outputs: [{ preset: 'h264', colorSpace: 'LOG', index: 0 }], opts: { ...opts, template: '{shot}_{sourceFilename}_{preset}' }, editSource: 'edit_v1' });
  assert.equal(findCollisions(unique).length, 0);
});

test('processed XML relinks clips and keeps untouched references valid', () => {
  const edit = readVideoClips(parseXmeml(fixture));
  const [a, b] = edit.clips; // 1C (disabled) is not published
  const published = [a, b].map((clip, i) => {
    const r = handleRange(clip, 12, 100);
    return {
      clip, outPath: `D:/publish/${clip.name}.mov`, outFrames: r.frames, headHandle: r.head,
      timecodeFrame: clip.file.timecodeFrame + r.start, width: 3840, height: 2160, audioChannels: i === 0 ? 2 : 0,
    };
  });
  const out = parseXmeml(writeProcessedXml(fixture, published));
  const items = new Map(Array.from(out.getElementsByTagName('clipitem')).map((c) => [c.getAttribute('id'), c]));

  const v1 = items.get('clipitem-1');
  assert.equal(text(child(v1, 'in')), '5'); // head handle clamped to 5
  assert.equal(text(child(v1, 'out')), '25');
  assert.equal(text(child(v1, 'pproTicksIn')), String(ticksForFrames(5, rate24)));
  assert.match(text(child(child(v1, 'file'), 'pathurl')), /publish\/1A\.mov$/);
  assert.equal(text(child(child(child(v1, 'file'), 'timecode'), 'frame')), '86400');

  const v2 = items.get('clipitem-2');
  assert.equal(text(child(v2, 'in')), '12');
  assert.equal(text(child(v2, 'out')), '20');

  // linked audio follows the video
  assert.equal(child(items.get('clipitem-4'), 'file').getAttribute('id'), child(v1, 'file').getAttribute('id'));

  // the disabled clip still points at file-1, which must still be defined somewhere
  assert.equal(child(items.get('clipitem-3'), 'file').getAttribute('id'), 'file-1');
  const defs = Array.from(out.getElementsByTagName('file')).filter((f) => f.getAttribute('id') === 'file-1' && child(f, 'pathurl'));
  assert.equal(defs.length, 1);

  assert.equal(text(child(out.documentElement.getElementsByTagName('sequence')[0], 'name')), 'edit_v1_processed');
});

test('source length in frames follows Premiere (duration rounded to nearest frame)', () => {
  const probe = (ticks) => ({ firstTime: 0, endTime: ticks / 600 });
  assert.equal(framesAtRate(probe(26546), 24), 1062); // 1061.84
  assert.equal(framesAtRate(probe(15662), 24), 626); // 626.48
});

test('Apple Log curve', () => {
  assert.ok(Math.abs(appleLogToLinear(0.4882) - 0.18) < 0.002, '18% grey sits near 0.488');
  assert.ok(appleLogToLinear(0) < 0);
});

test('Apple Log to Rec.709 exposure is in stops, 0 = neutral', () => {
  const grey = (stops) => appleLogToRec709([0.4882, 0.4882, 0.4882], stops)[0];
  assert.ok(Math.abs(grey(0) - 0.441) < 0.005, '18% grey lands near 44% at 0 stops');
  assert.ok(grey(1) > grey(0) && grey(0) > grey(-1));
});

test('colour matrices match published values', () => {
  const close = (a, b) => a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) < 1e-5));
  // Rec.709 -> ACEScg (Bradford), as published by the ACES project / colour-science
  assert.ok(close(conversionMatrix('rec709', 'acescg'), [
    [0.613097, 0.339523, 0.047379],
    [0.070194, 0.916354, 0.013452],
    [0.020616, 0.10957, 0.869815],
  ]));
  // Rec.2020 -> Rec.709 (same white point)
  assert.ok(close(conversionMatrix('rec2020', 'rec709'), [
    [1.660491, -0.587641, -0.07285],
    [-0.12455, 1.1329, -0.008349],
    [-0.018151, -0.100579, 1.11873],
  ]));
  for (const row of conversionMatrix('rec2020', 'acescg')) assert.ok(Math.abs(row.reduce((a, b) => a + b) - 1) < 1e-9, 'white stays white');
});

test('Apple Log linear 1D LUT keeps scene-linear values above 1', () => {
  const rows = buildLinear1D(4096).split('\n').filter((l) => /^-?\d/.test(l)).map((l) => Number(l.split(' ')[0]));
  assert.equal(rows.length, 4096);
  assert.ok(rows[rows.length - 1] > 1, 'highlights are not clipped');
  assert.ok(rows[0] < 0, 'black sits slightly below 0, as in the Apple Log spec');
});

test('output sizes are even and keep the aspect ratio', () => {
  const src = { width: 3840, height: 2160 };
  assert.deepEqual(outputSize(src, { scale: 'full' }), src);
  assert.deepEqual(outputSize(src, { scale: 'half' }), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(src, { scale: 'quarter' }), { width: 960, height: 540 });
  assert.deepEqual(outputSize(src, { scale: 'custom', width: 1280 }), { width: 1280, height: 720 });
  assert.deepEqual(outputSize({ width: 1918, height: 1080 }, { scale: 'quarter' }), { width: 480, height: 270 });
});

test('output validation', () => {
  const errs = (o) => normalizeOutput(o, BUILTIN_PRESETS).errors;
  assert.deepEqual(errs({ preset: 'exr16', color: 'applelog-acescg' }), []);
  assert.match(errs({ preset: 'prores422hq', color: 'applelog-acescg' })[0], /float format/);
  assert.match(errs({ preset: 'jpg', alpha: true })[0], /no alpha/);
  assert.match(errs({ preset: 'png8', scale: 'custom', width: 7 })[0], /Custom width/);
  assert.equal(normalizeOutput({ preset: 'exr16', color: 'applelog-acescg' }, BUILTIN_PRESETS).output.colorSpace, 'ACESCG');
});

test('float outputs never go through swscale after linearising', () => {
  const job = {
    preset: BUILTIN_PRESETS.exr16,
    output: { alpha: true },
    probe: { width: 3840, height: 2160, colorSpace: 'bt2020nc' },
    size: { width: 1920, height: 1080 },
  };
  const f = imageFilters(job, { mode: 'linear', lut1d: 'x.cube', matrix: conversionMatrix('rec2020', 'acescg') });
  const lin = f.findIndex((x) => x.startsWith('lut1d'));
  assert.ok(lin > 0);
  assert.ok(f.slice(lin).every((x) => !x.startsWith('scale=')), 'swscale would clamp values above 1');
  assert.ok(f.some((x) => x.startsWith('zscale=w=1920:h=1080')));
  assert.equal(f[f.length - 1], 'format=gbrapf32le');
});

test('one ffmpeg run per clip: decode once, split to every output', () => {
  const base = {
    probe: { width: 64, height: 36, colorSpace: 'bt2020nc', firstTime: 0, timeBase: { num: 1, den: 600 }, samples: [], audio: { channels: 2 } },
    size: { width: 64, height: 36 },
    clip: { name: '1A', file: { path: 'in.mov', rate: { timebase: 24, ntsc: false } }, rate: { timebase: 24, ntsc: false } },
    range: { start: 0, end: 10, frames: 10 },
  };
  const jobs = [
    { ...base, preset: BUILTIN_PRESETS.exr16, output: { exrCompression: 'dwaa' }, seq: { start: 1001 } },
    { ...base, preset: BUILTIN_PRESETS.exr16, output: { exrCompression: 'zip1' }, seq: { start: 1001 } },
    { ...base, preset: BUILTIN_PRESETS.prores422hq, output: {}, size: { width: 32, height: 18 } },
  ];
  const args = clipArgs(jobs, ['PIPE', 'seq.%04d.exr', 'movie.mov']);
  const inputs = args.flatMap((a, i) => (a === '-i' ? [args.slice(Math.max(0, i - 3), i)] : []));
  assert.equal(inputs.length, 2, 'video input + audio-only input');
  assert.ok(!inputs[0].includes('-vn') && inputs[1].includes('-vn'), 'the second input skips the video data');
  assert.ok(args.some((a) => a.startsWith('[1:a]')), 'audio comes from the audio-only input');
  const graphs = args.flatMap((a, i) => (args[i - 1] === '-filter_complex' ? [a] : []));
  assert.equal(graphs.length, 2, 'one video graph, one audio graph');
  // frames are selected and trimmed once, before the split, so every branch ends together
  assert.ok(graphs[0].includes('trim=end_frame=10,split=3[s0][s1][s2];'));
  assert.match(graphs[0], /\[s2\][^;]*scale=32:18[^;]*\[v2\]/, 'each output has its own size');
  assert.ok(graphs[1].startsWith('[1:a]') && graphs[1].includes('asplit=1[a2]'), 'audio only for the movie');
  assert.ok(!args.includes('-frames:v'), 'length comes from the trim, not per-output limits');
  const after = (target) => args.slice(0, args.indexOf(target) + 1);
  // DWAA: raw float frames to the OpenEXR helper's pipe, no ffmpeg EXR encoder
  assert.deepEqual(args.slice(args.indexOf('PIPE') - 2, args.indexOf('PIPE') + 1), ['-f', 'rawvideo', 'PIPE']);
  const zipArgs = args.slice(args.indexOf('PIPE') + 1, args.indexOf('seq.%04d.exr') + 1);
  assert.equal(zipArgs[zipArgs.indexOf('-compression') + 1], 'zip1');
  assert.equal(zipArgs[zipArgs.indexOf('-start_number') + 1], '1001');
  const movArgs = args.slice(args.indexOf('seq.%04d.exr') + 1);
  assert.ok(movArgs.includes('[a2]') && movArgs.includes('-timecode'));
  assert.ok(after('PIPE').includes('-progress'));
});

test('files mode: sequences are grouped, gaps found, names cleaned', async () => {
  const os = await import('node:os');
  const { discover, readExrHeader, spaceFromExr } = await import('../src/sources.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-seq-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    for (const n of [1001, 1002, 1004]) fs.writeFileSync(path.join(dir, `shot_A_1.${n}.exr`), '');
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, 'sub', `plate_${String(n).padStart(4, '0')}.png`), '');
    fs.writeFileSync(path.join(dir, 'sub', 'clip.mov'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');

    const flat = discover(dir, { recursive: false });
    assert.equal(flat.sequences.length, 1);
    const [a] = flat.sequences;
    assert.equal(a.name, 'shot_A_1');
    assert.deepEqual([a.first, a.last, a.pad, a.missing], [1001, 1004, 4, [1003]]);
    assert.equal(flat.movies.length, 0, 'subfolders are skipped unless recursive');

    const all = discover(dir, { recursive: true });
    assert.deepEqual(all.sequences.map((s) => s.name).sort(), ['plate', 'shot_A_1']);
    assert.equal(all.movies.length, 1);

    // one frame stands for its whole sequence
    const one = discover(path.join(dir, 'shot_A_1.1002.exr'));
    assert.equal(one.sequences.length, 1);
    assert.equal(one.sequences[0].frames.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // colour space from EXR headers
  assert.equal(spaceFromExr({ 'arnold/color_space': 'ACEScg' }).space, 'acescg');
  assert.equal(spaceFromExr({ 'arnold/color_space': 'scene-linear Rec 709/sRGB' }).space, 'lin_rec709');
  assert.equal(spaceFromExr({ chromaticities: [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767] }).space, 'acescg');
  assert.equal(spaceFromExr({}), null);
  assert.ok(typeof readExrHeader === 'function');
});

test('files mode: EXR header attributes are read', async () => {
  const os = await import('node:os');
  const { readExrHeader } = await import('../src/sources.js');
  // magic, version 2, then: name\0 type\0 size value ..., terminated by an empty name
  const attr = (name, type, value) => Buffer.concat([Buffer.from(`${name}\0${type}\0`, 'latin1'), Buffer.from(Int32Array.of(value.length).buffer), value]);
  const fps = Buffer.alloc(8);
  fps.writeInt32LE(24000, 0);
  fps.writeUInt32LE(1001, 4);
  const file = path.join(os.tmpdir(), `pp-header-${process.pid}.exr`);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from(Int32Array.of(20000630, 2).buffer),
    attr('arnold/color_space', 'string', Buffer.from('ACEScg')),
    attr('framesPerSecond', 'rational', fps),
    Buffer.from([0]),
  ]));
  try {
    const h = readExrHeader(file);
    assert.equal(h['arnold/color_space'], 'ACEScg');
    assert.ok(Math.abs(h.framesPerSecond - 23.976) < 0.001);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('files mode: flat names, or the source folder structure', () => {
  const clip = (name, relDir) => ({
    name, relDir, dir: path.join('in', relDir), in: 0, out: 10, start: 0, end: 10, effects: [], inputSpace: 'acescg',
    rate: { timebase: 24, ntsc: false }, file: { name, path: `${name}#.exr`, rate: { timebase: 24, ntsc: false }, duration: 10, width: 1920, height: 1080, sequence: { first: 1001 } },
  });
  const edit = { clips: [clip('a', 'x/one'), clip('b', 'x/two')] };
  const outputs = [{ preset: 'h265_preview', colorSpace: 'REC709', index: 0 }];
  const opts = { handles: 0, template: '{clipName}_{colorSpace}', out: 'out', version: 'v1', string: '' };
  const flat = buildJobs({ edit, probes: new Map(), presets: BUILTIN_PRESETS, outputs, opts, editSource: 'in' });
  assert.equal(flat[0].outPath, path.join('out', 'a_REC709.mp4'));
  const mirrored = buildJobs({ edit, probes: new Map(), presets: BUILTIN_PRESETS, outputs, opts: { ...opts, mirror: true }, editSource: 'in' });
  assert.equal(mirrored[1].outPath, path.join('out', 'x', 'two', 'b_REC709.mp4'));
  // sequences keep their own numbers in files mode
  const seq = buildJobs({ edit, probes: new Map(), presets: BUILTIN_PRESETS, outputs: [{ preset: 'exr16', colorSpace: null, index: 0 }], opts: { ...opts, keepNumbers: true }, editSource: 'in' });
  assert.equal(seq[0].seq.start, 1001);
  assert.equal(seq[0].colorSpace, 'ACESCG', '{colorSpace} falls back to the source space');
});

test('HDR PQ and 8-bit display sources convert to ACEScg', async () => {
  const { spaceFromMovie } = await import('../src/sources.js');
  const { colorResources } = await import('../src/publish.js');
  assert.equal(spaceFromMovie({ colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }).space, 'pq_rec2020');
  assert.equal(spaceFromMovie({ colorTransfer: 'bt709', colorPrimaries: 'bt709' }).space, 'rec709');

  const job = (pixFmt) => ({
    preset: BUILTIN_PRESETS.exr16, output: { alpha: false },
    probe: { width: 1920, height: 1080, colorSpace: 'bt2020nc', pixFmt }, size: { width: 1920, height: 1080 },
  });
  const exr = { color: 'acescg', exposure: 0 };
  // PQ: decoded by zscale (exact, unclamped), then Rec.2020 -> ACEScg
  const pq = colorResources(exr, 'pq_rec2020');
  assert.equal(pq.mode, 'linear');
  assert.ok(imageFilters(job('yuv422p10le'), pq).some((f) => f.startsWith('zscale=transferin=smpte2084:transfer=linear:npl=100')));
  // 8-bit Rec.709 video / sRGB: display curve undone with a 1D LUT, then Rec.709 -> ACEScg
  for (const space of ['rec709', 'srgb']) {
    const r = colorResources(exr, space);
    assert.equal(r.mode, 'linear');
    assert.ok(fs.existsSync(r.lut1d));
    assert.ok(Math.abs(r.matrix[0][0] - 0.613097) < 1e-5, 'Rec.709 primaries to ACEScg');
  }
  // no longer refused: display-referred material may go to ACEScg
  const { normalizeOutput } = await import('../src/publish.js');
  assert.deepEqual(normalizeOutput({ preset: 'exr16', color: 'acescg' }, BUILTIN_PRESETS).errors, []);
});
