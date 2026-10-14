import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { framesToTimecode } from './xmeml.js';

export const FRAME_MATCH = {
  nearest: 'each frame slot shows the sample whose timestamp is nearest (Premiere-style conform)',
  covering: 'each frame slot shows the latest sample starting at or before it',
  index: 'frame N is the Nth sample, ignoring timestamps',
};

function fpsExpr(rate) {
  return rate.ntsc ? `${rate.timebase * 1000}/1001` : String(rate.timebase);
}

function fpsValue(rate) {
  return rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
}

const t6 = (s) => s.toFixed(6);

/** Video and audio filter chains that pick frames [start, end) of the edit at the source's frame rate. */
export function selectionFilters(job, frameMatch) {
  const { probe, range, clip } = job;
  const rate = clip.file.rate ?? clip.rate;
  const fps = fpsValue(rate);
  const t0 = probe.firstTime + range.start / fps; // time of the first published frame
  const seek = Math.max(0, t0 - 1); // all-intra sources: a short pre-roll is cheap
  let video;
  if (frameMatch === 'index') {
    const first = probe.samples[range.start];
    const firstSec = (first.pts * probe.timeBase.num) / probe.timeBase.den;
    video = [`select='gte(t,${t6(firstSec - 1e-6)})'`, `setpts=N/(${fpsExpr(rate)})/TB`];
  } else {
    video = [
      `setpts=PTS-${t6(probe.firstTime)}/TB`,
      `fps=fps=${fpsExpr(rate)}:round=${frameMatch === 'covering' ? 'up' : 'near'}`,
      // select, not trim: trim also keeps a frame that merely overlaps the start time
      `select='gte(t,${t6((range.start - 0.5) / fps)})'`,
      'setpts=PTS-STARTPTS',
    ];
  }
  const audio = [`atrim=start=${t6(t0)}:duration=${t6(range.frames / fps)}`, 'asetpts=PTS-STARTPTS'];
  return { seek, video, audio, rate };
}

function colorFilters(lut, pixFmt) {
  if (!lut) return [`format=${pixFmt}`];
  const lutPath = lut.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return [
    'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc',
    'format=gbrp16le',
    `lut3d=file='${lutPath}':interp=tetrahedral`,
    'scale=out_color_matrix=bt709:out_range=tv',
    `format=${pixFmt}`,
  ];
}

export function ffmpegArgs(job, { lut, colorSpaceOut, frameMatch = 'nearest' }) {
  const { probe, range, preset, clip } = job;
  const sel = selectionFilters(job, frameMatch);
  const tcFrame = (clip.file.timecodeFrame ?? 0) + range.start;

  // Tag through the filter graph: frames carry the source's colour properties, and those
  // win over encoder-level -color_* options.
  const tags =
    colorSpaceOut === 'rec709'
      ? { color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709' }
      : {
          ...(probe.colorPrimaries && probe.colorPrimaries !== 'unknown' ? { color_primaries: probe.colorPrimaries } : {}),
          ...(probe.colorTransfer && probe.colorTransfer !== 'unknown' ? { color_trc: probe.colorTransfer } : {}),
          ...(probe.colorSpace && probe.colorSpace !== 'unknown' ? { colorspace: probe.colorSpace } : {}),
        };
  const setparams = 'setparams=' + Object.entries({ range: 'tv', ...tags }).map(([k, v]) => `${k}=${v}`).join(':');

  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y',
    '-copyts',
    '-ss', t6(sel.seek),
    '-i', clip.file.path,
    '-map', '0:v:0',
    ...(probe.audio ? ['-map', '0:a:0'] : []),
    '-vf', [...sel.video, ...colorFilters(lut, preset.pixFmt), setparams].join(','),
    ...(probe.audio ? ['-af', sel.audio.join(',')] : []),
    '-frames:v', String(range.frames),
    '-r', fpsExpr(sel.rate),
    ...preset.video,
    ...(probe.audio ? preset.audio : ['-an']),
    ...(preset.extra ?? []),
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-timecode', framesToTimecode(tcFrame, sel.rate, clip.file.dropFrame),
    '-metadata', `comment=platepuller source=${path.basename(clip.file.path)} frames=${range.start}-${range.end - 1} clip=${clip.name}`,
    job.outPath,
  ];
}

export function runFfmpeg(args, { ffmpeg = 'ffmpeg', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line.match(/^frame=(\d+)/);
        if (m && onProgress) onProgress(Number(m[1]));
      }
    });
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`))));
  });
}

export async function encodeJob(job, opts) {
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  const tmp = job.outPath.replace(/(\.[^.]+)$/, '.partial$1');
  try {
    await runFfmpeg(ffmpegArgs({ ...job, outPath: tmp }, opts), opts);
    fs.renameSync(tmp, job.outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
