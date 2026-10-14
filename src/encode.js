import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { framesToTimecode } from './xmeml.js';
import os from 'node:os';
import { OPENEXR_COMPRESSION, streamExrSequence } from './openexr.js';

// Compression threads per OpenEXR sequence; several encodes may run at once.
const EXR_THREADS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 3)));

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

// A path inside a filtergraph option: forward slashes, escaped colons and quotes.
const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

// swscale's name for the source YUV matrix
function sourceMatrix(probe) {
  const cs = probe.colorSpace ?? '';
  if (cs.startsWith('bt2020')) return 'bt2020';
  if (cs === 'smpte170m' || cs === 'bt470bg') return 'bt601';
  return 'bt709';
}

/**
 * Colour conversion, resize and final pixel format for one output.
 * Stays in the source's YUV when nothing needs RGB; otherwise works in 16-bit or float RGB.
 */
export function imageFilters(job, color) {
  const { preset, output, probe, size } = job;
  const target = preset.space; // yuv | rgb | jpeg | float
  const pixFmt = output.alpha && preset.alphaPixFmt ? preset.alphaPixFmt : preset.pixFmt;
  const matrix = sourceMatrix(probe);
  const f = [];
  let rgb = false;
  const toRgb = (fmt) => {
    f.push(`scale=in_color_matrix=${matrix}:in_range=tv:out_range=pc`, `format=${fmt}`);
    rgb = true;
  };

  if (color.mode === 'applelog-rec709' || color.mode === 'lut') {
    toRgb('gbrp16le');
    f.push(`lut3d=file='${filterPath(color.lut3d)}':interp=tetrahedral`);
  } else if (color.mode === 'applelog-acescg') {
    // log -> scene-linear Rec.2020 (1D LUT), then Rec.2020 -> ACEScg primaries (matrix), all in float
    toRgb('gbrpf32le');
    const m = color.matrix;
    const mix = ['r', 'g', 'b'].flatMap((o, i) => ['r', 'g', 'b'].map((c, j) => `${o}${c}=${m[i][j].toFixed(8)}`)).join(':');
    f.push(`lut1d=file='${filterPath(color.lut1d)}':interp=linear`, `colorchannelmixer=${mix}`);
  } else if (target !== 'yuv') {
    toRgb(target === 'float' ? 'gbrpf32le' : 'gbrp16le');
  }

  const resize = size.width !== probe.width || size.height !== probe.height;
  if (target === 'float') {
    // swscale clamps float to 0-1 (and works in integers), which would clip scene-linear
    // highlights; zimg keeps floats intact, so it does the resize and the final conversion.
    f.push(resize ? `zscale=w=${size.width}:h=${size.height}:filter=lanczos` : 'zscale');
  } else if (resize) {
    f.push(`scale=${size.width}:${size.height}:flags=lanczos`);
  }

  if (rgb && target === 'yuv') f.push(`scale=out_color_matrix=${color.display === 'rec709' ? 'bt709' : matrix}:out_range=tv`);
  if (target === 'jpeg') f.push('scale=out_color_matrix=bt601:out_range=pc'); // JPEG/JFIF is full-range BT.601
  f.push(`format=${pixFmt}`);

  if (preset.kind === 'movie') {
    // Tag through the filter graph: frames carry the source's colour properties, and those
    // win over encoder-level -color_* options.
    const tags =
      color.display === 'rec709'
        ? { color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709' }
        : {
            ...(probe.colorPrimaries && probe.colorPrimaries !== 'unknown' ? { color_primaries: probe.colorPrimaries } : {}),
            ...(probe.colorTransfer && probe.colorTransfer !== 'unknown' ? { color_trc: probe.colorTransfer } : {}),
            ...(probe.colorSpace && probe.colorSpace !== 'unknown' ? { colorspace: probe.colorSpace } : {}),
          };
    f.push('setparams=' + Object.entries({ range: 'tv', ...tags }).map(([k, v]) => `${k}=${v}`).join(':'));
  }
  return f;
}

/** ffmpeg arguments for one job. `outPath` is the movie file, or the frame pattern for a sequence. */
export function ffmpegArgs(job, { color = { mode: 'none' }, frameMatch = 'nearest' } = {}, outPath = job.outPath) {
  const { probe, range, preset, clip, output } = job;
  const sel = selectionFilters(job, frameMatch);
  const toPipe = outPath === 'pipe:1';
  const input = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...(toPipe ? [] : ['-progress', 'pipe:1']), // stdout carries the frames when piping
    '-y', '-copyts', '-ss', t6(sel.seek), '-i', clip.file.path,
  ];
  const vf = [...sel.video, ...imageFilters(job, color)].join(',');

  if (preset.kind === 'sequence') {
    const head = [...input, '-map', '0:v:0', '-vf', vf, '-frames:v', String(range.frames), '-an', '-map_metadata', '-1'];
    // raw planar float frames for OpenEXR to compress (DWAA/DWAB/PIZ)
    if (toPipe) return [...head, '-f', 'rawvideo', 'pipe:1'];
    return [
      ...head,
      ...preset.video,
      ...(preset.ext === 'exr' ? ['-compression', output.exrCompression ?? 'zip16'] : []),
      '-f', 'image2', '-start_number', String(job.seq.start),
      outPath,
    ];
  }

  const tcFrame = (clip.file.timecodeFrame ?? 0) + range.start;
  return [
    ...input,
    '-map', '0:v:0',
    ...(probe.audio ? ['-map', '0:a:0'] : []),
    '-vf', vf,
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
    outPath,
  ];
}

export function runFfmpeg(args, { ffmpeg = 'ffmpeg', onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const proc = spawn(ffmpeg, args, { windowsHide: true, signal });
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
    // On cancel, 'error' fires as soon as the kill is sent; settle only once ffmpeg has exited
    // and released the output file. A spawn failure (ffmpeg missing) never gets a 'close'.
    let failure = null;
    proc.on('error', (err) => {
      failure = err;
      if (proc.pid === undefined) reject(err);
    });
    proc.on('close', (code) => {
      if (signal?.aborted) reject(new Error('cancelled'));
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
    });
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sequenceFrames(seq, dir = seq.dir) {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${escapeRe(seq.name)}\\.\\d+\\.${escapeRe(seq.ext)}$`, 'i');
  return fs.readdirSync(dir).filter((f) => re.test(f));
}

/** True when this job's movie file, or any frame of its sequence, is already on disk. */
export function outputExists(job) {
  return job.seq ? sequenceFrames(job.seq).length > 0 : fs.existsSync(job.outPath);
}

// A killed ffmpeg can hold files for a moment on Windows, hence the retries.
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/**
 * Encode one job. Everything is written next to the target first (file.partial.mov or
 * folder.partial/) and only moved into place once ffmpeg has succeeded.
 */
export async function encodeJob(job, opts) {
  if (job.seq) return encodeSequence(job, opts);
  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  const tmp = job.outPath.replace(/(\.[^.]+)$/, '.partial$1');
  try {
    await runFfmpeg(ffmpegArgs(job, opts, tmp), opts);
    fs.renameSync(tmp, job.outPath);
  } catch (err) {
    rm(tmp);
    throw err;
  }
}

async function encodeSequence(job, opts) {
  const seq = job.seq;
  const tmp = `${seq.dir}.partial`;
  rm(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  // The image2 muxer expands % anywhere in the path, so literal % signs are doubled.
  const pattern = path.join(tmp, seq.name).replace(/%/g, '%%') + `.%0${seq.pad}d.${seq.ext}`;
  try {
    if (seq.ext === 'exr' && OPENEXR_COMPRESSION.has(job.output.exrCompression)) {
      // ffmpeg -> pipe -> OpenEXR: no uncompressed frames ever touch the disk
      await streamExrSequence(
        {
          ffmpeg: [opts.ffmpeg ?? 'ffmpeg', ...ffmpegArgs(job, opts, 'pipe:1')],
          width: job.size.width,
          height: job.size.height,
          channels: job.output.alpha ? 4 : 3,
          half: job.preset.video.includes('half'),
          compression: job.output.exrCompression,
          level: job.output.dwaLevel ?? 45,
          dir: tmp,
          name: seq.name,
          ext: seq.ext,
          start: seq.start,
          pad: seq.pad,
          frames: job.range.frames,
          threads: EXR_THREADS,
        },
        opts,
      );
    } else {
      await runFfmpeg(ffmpegArgs(job, opts, pattern), opts);
    }
    fs.mkdirSync(seq.dir, { recursive: true });
    for (const f of sequenceFrames(seq)) fs.rmSync(path.join(seq.dir, f)); // frames of an earlier version
    for (const f of fs.readdirSync(tmp)) fs.renameSync(path.join(tmp, f), path.join(seq.dir, f));
    rm(tmp);
  } catch (err) {
    rm(tmp);
    throw err;
  }
}
