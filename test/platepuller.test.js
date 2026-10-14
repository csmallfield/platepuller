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
import { handleRange, buildJobs, findCollisions } from '../src/plan.js';
import { framesAtRate } from '../src/probe.js';
import { appleLogToLinear, appleLogToRec709 } from '../src/applelog.js';

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
