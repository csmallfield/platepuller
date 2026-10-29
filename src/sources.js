// Files-and-folders input: find movie files and image sequences, read what they are,
// and describe each as a "clip" the rest of the pipeline can publish like an edit's clip.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeSource } from './probe.js';

const run = promisify(execFile);

export const IMAGE_EXT = new Set(['exr', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'dpx']);
export const MOVIE_EXT = new Set(['mov', 'mp4', 'm4v', 'mxf', 'avi', 'mkv', 'webm']);

// name.1001.exr, name_1001.exr, name1001.exr -> prefix "name." / "name_" / "name", number, ext
const FRAME = /^(.*?)(\d+)\.([A-Za-z]+)$/;

const extOf = (f) => path.extname(f).slice(1).toLowerCase();

function listFiles(dir, recursive) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && !e.name.startsWith('.')) out.push(...listFiles(p, recursive));
    } else if (IMAGE_EXT.has(extOf(e.name)) || MOVIE_EXT.has(extOf(e.name))) out.push(p);
  }
  return out;
}

/** Group image files into sequences; everything else is a movie. */
function group(files) {
  const seqs = new Map();
  const movies = [];
  for (const f of files) {
    const ext = extOf(f);
    if (MOVIE_EXT.has(ext)) {
      movies.push(f);
      continue;
    }
    const m = path.basename(f).match(FRAME);
    const key = m ? `${path.dirname(f)}|${m[1]}|${m[3].toLowerCase()}` : `${f}|still`;
    if (!seqs.has(key)) seqs.set(key, { dir: path.dirname(f), prefix: m ? m[1] : null, ext: m ? m[3] : ext, frames: [] });
    seqs.get(key).frames.push(m ? { n: Number(m[2]), digits: m[2], file: f } : { n: 0, digits: '', file: f });
  }
  const sequences = [...seqs.values()].map((s) => {
    s.frames.sort((a, b) => a.n - b.n);
    const first = s.frames[0].n;
    const last = s.frames[s.frames.length - 1].n;
    const pad = Math.min(...s.frames.map((f) => f.digits.length));
    const have = new Set(s.frames.map((f) => f.n));
    const missing = [];
    for (let n = first; n <= last && missing.length <= 1000; n++) if (!have.has(n)) missing.push(n);
    const name = (s.prefix ?? path.parse(s.frames[0].file).name).replace(/[._\-\s]+$/, '') || path.basename(s.dir);
    const padded = s.frames.every((f) => f.digits.length === pad);
    return { kind: 'sequence', dir: s.dir, name, prefix: s.prefix ?? '', ext: s.ext, first, last, pad, padded, frames: s.frames, missing };
  });
  return { sequences, movies };
}

/** Everything under `input` (a file, one frame of a sequence, or a folder). */
export function discover(input, { recursive = false } = {}) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    const { sequences, movies } = group(listFiles(input, recursive));
    return { root: input, sequences, movies };
  }
  const root = path.dirname(input);
  const ext = extOf(input);
  if (MOVIE_EXT.has(ext)) return { root, sequences: [], movies: [input] };
  if (!IMAGE_EXT.has(ext)) throw new Error(`Not a movie or image file: ${input}`);
  // a frame of a sequence: take its siblings with the same name pattern
  const { sequences } = group(listFiles(root, false));
  const seq = sequences.find((s) => s.frames.some((f) => path.resolve(f.file) === path.resolve(input)));
  return { root, sequences: seq ? [seq] : [], movies: [] };
}

// ---- EXR header -----------------------------------------------------------------------

/** The attributes of an EXR's (first) header that tell us what it is. */
export function readExrHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let buf = Buffer.alloc(1 << 16);
    let len = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.readUInt32LE(0) !== 20000630) throw new Error('not an OpenEXR file');
    const attrs = {};
    let p = 8;
    const need = (n) => {
      while (p + n > len) {
        if (len < buf.length) throw new Error('truncated header');
        const bigger = Buffer.alloc(buf.length * 4);
        buf.copy(bigger, 0, 0, len);
        buf = bigger;
        len += fs.readSync(fd, buf, len, buf.length - len, len);
      }
    };
    const cstr = () => {
      let e;
      for (;;) {
        e = buf.indexOf(0, p);
        if (e >= 0 && e < len) break;
        need(len - p + 1);
      }
      const s = buf.toString('latin1', p, e);
      p = e + 1;
      return s;
    };
    for (;;) {
      const name = cstr();
      if (!name) break;
      const type = cstr();
      need(4);
      const size = buf.readInt32LE(p);
      p += 4;
      need(size);
      const v = buf.subarray(p, p + size);
      if (type === 'string') attrs[name] = v.toString('utf8');
      else if (type === 'float') attrs[name] = v.readFloatLE(0);
      else if (type === 'int') attrs[name] = v.readInt32LE(0);
      else if (type === 'rational') attrs[name] = v.readInt32LE(0) / v.readUInt32LE(4);
      else if (type === 'chromaticities') attrs[name] = Array.from({ length: 8 }, (_, i) => v.readFloatLE(i * 4));
      p += size;
    }
    return attrs;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- colour spaces --------------------------------------------------------------------

export const SOURCE_SPACES = {
  auto: 'Auto (from the files)',
  acescg: 'ACEScg (scene-linear)',
  lin_rec709: 'Linear Rec.709 / sRGB (scene-linear)',
  lin_rec2020: 'Linear Rec.2020 (scene-linear)',
  aces2065: 'ACES2065-1 (scene-linear)',
  applelog: 'Apple Log',
  pq_rec2020: 'Rec.2100 PQ (BT.2020, SMPTE ST 2084 HDR)',
  rec709: 'Rec.709 video (display)',
  srgb: 'sRGB (display)',
};
export const SPACE_LABEL = {
  acescg: 'ACESCG', lin_rec709: 'LIN709', lin_rec2020: 'LIN2020', aces2065: 'ACES', applelog: 'LOG', pq_rec2020: 'PQ2020', rec709: 'REC709', srgb: 'SRGB',
};
// Spaces that hold scene light (or, for PQ, absolute light) that the Rec.709 view tone-maps.
// Rec.709 video and sRGB are display-referred: already "viewed".
export const SCENE_SPACES = new Set(['acescg', 'lin_rec709', 'lin_rec2020', 'aces2065', 'applelog', 'pq_rec2020']);

const PRIMARIES = {
  acescg: [0.713, 0.293, 0.165, 0.83, 0.128, 0.044],
  aces2065: [0.7347, 0.2653, 0, 1, 0.0001, -0.077],
  lin_rec709: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06],
  lin_rec2020: [0.708, 0.292, 0.17, 0.797, 0.131, 0.046],
};

/** Colour space of an EXR from its header: { space, from } or null. */
export function spaceFromExr(attrs) {
  for (const key of ['arnold/color_space', 'oiio:ColorSpace', 'colorSpace', 'colorspace', 'color_space', 'ocio:colorspace']) {
    const v = String(attrs[key] ?? '').toLowerCase();
    if (!v) continue;
    const space =
      /acescg|lin_ap1|ap1/.test(v) ? 'acescg'
      : /aces2065|lin_ap0|ap0|aces - aces/.test(v) ? 'aces2065'
      : /2020/.test(v) && /lin/.test(v) ? 'lin_rec2020'
      : /lin|scene/.test(v) && /709|srgb/.test(v) ? 'lin_rec709'
      : /srgb/.test(v) ? 'srgb'
      : null;
    if (space) return { space, from: `${key} = "${attrs[key]}"` };
  }
  const c = attrs.chromaticities;
  if (c) {
    for (const [space, p] of Object.entries(PRIMARIES)) {
      if (p.every((v, i) => Math.abs(v - c[i]) < 0.002)) return { space, from: 'chromaticities' };
    }
  }
  return null;
}

/** Colour space of a movie from its stream tags. */
export function spaceFromMovie(probe) {
  if (probe.colorTransfer === 'smpte2084') return { space: 'pq_rec2020', from: 'stream tags (SMPTE ST 2084 / PQ)' };
  if (probe.colorTransfer === 'bt709' || (probe.colorPrimaries === 'bt709' && probe.colorTransfer !== 'unknown')) return { space: 'rec709', from: 'stream tags (BT.709)' };
  if (probe.colorPrimaries === 'bt2020' && (!probe.colorTransfer || probe.colorTransfer === 'unknown') && probe.make === 'Apple') {
    return { space: 'applelog', from: 'Apple camera, Rec.2020 primaries, log transfer' };
  }
  return null;
}

// ---- probing --------------------------------------------------------------------------

async function probeImage(file, ffprobe = 'ffprobe') {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams[0];
  if (!s) throw new Error(`Cannot read ${file}`);
  return { codec: s.codec_name, width: s.width, height: s.height, pixFmt: s.pix_fmt };
}

const rateFrom = (fps) => {
  const f = Number(fps);
  for (const tb of [24, 30, 60]) if (Math.abs(f - (tb * 1000) / 1001) < 0.01) return { timebase: tb, ntsc: true };
  return { timebase: Math.round(f) || 24, ntsc: false };
};

/**
 * Turn discovered sources into clips + probes for the publish pipeline.
 * opts: { fps (sequences, overrides headers), range: { first, last } (single source only) }
 */
export async function sourcesToClips(found, opts = {}) {
  const clips = [];
  const probes = new Map();
  const notes = [];
  const errors = [];
  const single = found.sequences.length + found.movies.length === 1;

  for (const s of found.sequences) {
    const firstFile = s.frames[0].file;
    let info;
    try {
      info = await probeImage(firstFile);
    } catch (err) {
      errors.push(`Could not read ${firstFile}: ${err.message.split('\n')[0]}`);
      continue;
    }
    let attrs = {};
    if (s.ext.toLowerCase() === 'exr') {
      try {
        attrs = readExrHeader(firstFile);
      } catch {
        /* unreadable header: no metadata */
      }
    }
    const detected = s.ext.toLowerCase() === 'exr' ? spaceFromExr(attrs) : { space: 'srgb', from: 'image file' };
    const headerFps = attrs.framesPerSecond ?? attrs['arnold/fps'];
    const rate = rateFrom(opts.fps || headerFps || 24);
    let first = s.first;
    let last = s.last;
    if (single && opts.range) {
      first = Math.max(first, Number(opts.range.first ?? first));
      last = Math.min(last, Number(opts.range.last ?? last));
      if (!(first <= last)) errors.push(`Frame range ${opts.range.first}-${opts.range.last} is outside ${s.first}-${s.last}`);
    }
    const missing = s.missing.filter((n) => n >= first && n <= last);
    const frames = last - first + 1;
    const key = path.join(s.dir, `${s.prefix}#.${s.ext}`);
    const warnings = [];
    if (missing.length) warnings.push(`${missing.length} missing frame(s), e.g. ${missing.slice(0, 3).join(', ')}: the previous frame is held`);
    if (s.frames.length === 1 && !s.prefix) warnings.push('single image');
    clips.push({
      id: key,
      name: s.name,
      enabled: true,
      in: 0,
      out: frames,
      start: 0,
      end: frames,
      rate,
      effects: [],
      warnings,
      dir: s.dir,
      detected,
      file: {
        path: key,
        name: s.name,
        rate,
        duration: frames,
        timecodeFrame: first,
        dropFrame: false,
        width: info.width,
        height: info.height,
        sequence: { dir: s.dir, prefix: s.prefix, ext: s.ext, pad: s.pad, padded: s.padded, first, last, files: s.frames.filter((f) => f.n >= first && f.n <= last), missing },
      },
    });
    probes.set(key, {
      kind: 'sequence',
      width: info.width,
      height: info.height,
      pixFmt: info.pixFmt,
      codec: info.codec,
      audio: null,
      firstTime: 0,
      endTime: frames / (rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase),
      fps: headerFps,
    });
  }

  for (const m of found.movies) {
    let probe;
    try {
      probe = await probeSource(m);
    } catch (err) {
      errors.push(`Could not read ${m}: ${err.message.split('\n')[0]}`);
      continue;
    }
    const [num, den] = String(probe.nominalRate).split('/').map(Number);
    const rate = rateFrom(num / (den || 1));
    const fps = rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
    const total = Math.round((probe.endTime - probe.firstTime) * fps);
    let first = 0;
    let last = total - 1;
    if (single && opts.range) {
      first = Math.max(0, Number(opts.range.first ?? 0));
      last = Math.min(total - 1, Number(opts.range.last ?? total - 1));
      if (!(first <= last)) errors.push(`Frame range ${opts.range.first}-${opts.range.last} is outside 0-${total - 1}`);
    }
    const name = path.parse(m).name;
    clips.push({
      id: m,
      name,
      enabled: true,
      in: first,
      out: last + 1,
      start: 0,
      end: last + 1 - first,
      rate,
      effects: [],
      warnings: [],
      dir: path.dirname(m),
      detected: spaceFromMovie(probe),
      file: { path: m, name: path.basename(m), rate, duration: total, timecodeFrame: 0, dropFrame: false, width: probe.width, height: probe.height },
    });
    probes.set(m, { ...probe, kind: 'movie' });
  }

  if (!clips.length && !errors.length) notes.push('No movie files or image sequences found.');
  clips.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
  return { clips, probes, notes, errors };
}
