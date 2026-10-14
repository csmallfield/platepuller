import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { framesToTimecode } from './xmeml.js';
import { OPENEXR_COMPRESSION, serveExrSequence } from './openexr.js';

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

/** True for EXR outputs that OpenEXR (not ffmpeg) compresses: ffmpeg sends them raw frames. */
export const viaOpenEXR = (job) => job.preset.ext === 'exr' && OPENEXR_COMPRESSION.has(job.output.exrCompression);

/** Output options for one output of a clip's ffmpeg run; `i` is its index in the filtergraph. */
function outputArgs(job, i, target, withAudio, rate) {
  const { preset, range, clip, output } = job;
  const common = ['-map', `[v${i}]`, '-frames:v', String(range.frames), '-map_metadata', '-1'];
  // raw planar float frames for OpenEXR to compress (DWAA/DWAB/PIZ)
  if (viaOpenEXR(job)) return [...common, '-f', 'rawvideo', target];
  if (preset.kind === 'sequence') {
    return [
      ...common,
      ...preset.video,
      ...(preset.ext === 'exr' ? ['-compression', output.exrCompression ?? 'zip16'] : []),
      '-f', 'image2', '-start_number', String(job.seq.start),
      target,
    ];
  }
  const tcFrame = (clip.file.timecodeFrame ?? 0) + range.start;
  return [
    ...common,
    ...(withAudio ? ['-map', `[a${i}]`] : []),
    '-r', fpsExpr(rate),
    ...preset.video,
    ...(withAudio ? preset.audio : []),
    ...(preset.extra ?? []),
    '-map_chapters', '-1',
    '-timecode', framesToTimecode(tcFrame, rate, clip.file.dropFrame),
    '-metadata', `comment=platepuller source=${path.basename(clip.file.path)} frames=${range.start}-${range.end - 1} clip=${clip.name}`,
    target,
  ];
}

/**
 * One ffmpeg run for every output of a clip: the source is read, decoded and frame-selected
 * once, then split to each output's colour / resize / encoder chain.
 * `jobs` all belong to the same clip; `targets[i]` is where output i goes (file, frame
 * pattern or pipe); `colors[i]` comes from colorResources().
 */
export function clipArgs(jobs, targets, { colors = [], frameMatch = 'nearest' } = {}) {
  const { probe, clip } = jobs[0];
  const sel = selectionFilters(jobs[0], frameMatch);
  // One filtergraph per output, all fed by the same decoded stream: ffmpeg runs each graph on
  // its own thread, where a single graph with split would run every chain on one thread.
  const graphs = jobs.map((j, i) => `[0:v]${[...sel.video, ...imageFilters(j, colors[i] ?? { mode: 'none' })].join(',')}[v${i}]`);
  const audio = jobs.map((j, i) => (j.preset.kind === 'movie' && probe.audio ? i : -1)).filter((i) => i >= 0);
  if (audio.length) graphs.push(`[0:a]${sel.audio.join(',')},asplit=${audio.length}${audio.map((i) => `[a${i}]`).join('')}`);
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
    '-y', '-copyts', '-ss', t6(sel.seek), '-i', clip.file.path,
    ...graphs.flatMap((g) => ['-filter_complex', g]),
    ...jobs.flatMap((j, i) => outputArgs(j, i, targets[i], audio.includes(i), sel.rate)),
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

let pipeCounter = 0;

/** Where a job is written while encoding: next to its target, moved into place on success. */
function staging(job) {
  if (!job.seq) {
    fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
    const tmp = job.outPath.replace(/(\.[^.]+)$/, '.partial$1');
    return { tmp, target: tmp };
  }
  const tmp = `${job.seq.dir}.partial`;
  rm(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  if (viaOpenEXR(job)) {
    const target =
      process.platform === 'win32' ? `\\\\.\\pipe\\platepuller-${process.pid}-${++pipeCounter}` : path.join(tmp, '.frames.fifo');
    return { tmp, target };
  }
  // The image2 muxer expands % anywhere in the path, so literal % signs are doubled.
  return { tmp, target: path.join(tmp, job.seq.name).replace(/%/g, '%%') + `.%0${job.seq.pad}d.${job.seq.ext}` };
}

function publishStaged(job, tmp) {
  if (!job.seq) return fs.renameSync(tmp, job.outPath);
  const seq = job.seq;
  fs.mkdirSync(seq.dir, { recursive: true });
  for (const f of sequenceFrames(seq)) fs.rmSync(path.join(seq.dir, f)); // frames of an earlier version
  for (const f of fs.readdirSync(tmp)) if (!f.startsWith('.')) fs.renameSync(path.join(tmp, f), path.join(seq.dir, f));
  rm(tmp);
}

/**
 * Encode every output of one clip with a single ffmpeg run (see clipArgs).
 * opts: { colors (per job), frameMatch, signal, onProgress(job, framesDone) }.
 * All outputs succeed or fail together; nothing is moved into place unless all succeeded.
 */
export async function encodeClip(jobs, opts = {}) {
  const staged = jobs.map(staging);
  const helpers = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    // Start the OpenEXR writers first: they create the pipes ffmpeg writes to.
    jobs.forEach((job, i) => {
      if (!viaOpenEXR(job)) return;
      const seq = job.seq;
      const helper = serveExrSequence(
        {
          pipe: staged[i].target,
          width: job.size.width,
          height: job.size.height,
          channels: job.output.alpha ? 4 : 3,
          half: job.preset.video.includes('half'),
          compression: job.output.exrCompression,
          level: job.output.dwaLevel ?? 45,
          dir: staged[i].tmp,
          name: seq.name,
          ext: seq.ext,
          start: seq.start,
          pad: seq.pad,
          frames: job.range.frames,
          threads: EXR_THREADS,
        },
        { signal: controller.signal, onProgress: (n) => opts.onProgress?.(job, n) },
      );
      helpers.push(helper.done);
      helper.done.catch(stop); // a failed writer stops ffmpeg instead of leaving it blocked
      staged[i].ready = helper.ready;
    });
    await Promise.all(staged.map((s) => s.ready).filter(Boolean));

    const args = clipArgs(jobs, staged.map((s) => s.target), opts);
    const ffmpegRun = runFfmpeg(args, {
      ...opts,
      signal: controller.signal,
      onProgress: (frame) => jobs.forEach((job) => !viaOpenEXR(job) && opts.onProgress?.(job, frame)),
    });
    ffmpegRun.catch(stop); // ffmpeg failed: the writers will never get their frames
    // Wait for every process to exit before touching the staging folders, and report the
    // real failure rather than the 'cancelled' of the processes stopped because of it.
    const results = await Promise.allSettled([ffmpegRun, ...helpers]);
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failures.length) throw failures.find((e) => e.message !== 'cancelled') ?? failures[0];
    jobs.forEach((job, i) => publishStaged(job, staged[i].tmp));
  } catch (err) {
    stop(); // e.g. a writer died before it was ready: stop the rest and let them exit first
    await Promise.allSettled(helpers);
    for (const s of staged) rm(s.tmp);
    throw opts.signal?.aborted ? new Error('cancelled') : err;
  } finally {
    opts.signal?.removeEventListener('abort', stop);
  }
}
