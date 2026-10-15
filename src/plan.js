// Turn an edit + options into a list of encode jobs.
import path from 'node:path';
import { rateFps, rateLabel } from './xmeml.js';
import { framesAtRate } from './probe.js';
import { renderTemplate } from './template.js';
import { SPACE_LABEL } from './sources.js';

export function handleRange(clip, handles, sourceFrames) {
  const available = Math.min(clip.file.duration ?? Infinity, sourceFrames ?? Infinity);
  const head = Math.max(0, Math.min(handles, clip.in));
  const tail = Math.max(0, Math.min(handles, available - clip.out));
  return {
    head,
    tail,
    start: clip.in - head,
    end: clip.out + tail, // exclusive
    frames: clip.out - clip.in + head + tail,
  };
}

const even = (n) => Math.max(2, 2 * Math.round(n / 2));

/** Output frame size for an output's resolution setting. Even sizes, so 4:2:0 codecs accept them. */
export function outputSize(source, output) {
  const { width, height } = source;
  switch (output.scale) {
    case 'half':
      return { width: even(width / 2), height: even(height / 2) };
    case 'quarter':
      return { width: even(width / 4), height: even(height / 4) };
    case 'custom':
      return { width: even(output.width), height: even((output.width * height) / width) };
    default:
      return { width, height };
  }
}

export function shotNumber(index, step = 10, width = 3) {
  return String((index + 1) * step).padStart(width, '0');
}

/**
 * One job per clip per output. `outputs` are { preset, colorSpace, index, ... };
 * `opts` carries template, out, handles, version, string.
 */
export function buildJobs({ edit, probes, presets, outputs, opts, editSource }) {
  const jobs = [];
  edit.clips.forEach((clip, index) => {
    const probe = probes.get(clip.file.path);
    const fps = rateFps(clip.file.rate ?? clip.rate);
    const sourceFrames = probe ? framesAtRate(probe, fps) : undefined;
    const range = handleRange(clip, opts.handles, sourceFrames);
    const warnings = [];
    if (probe && clip.file.duration && Math.abs(sourceFrames - clip.file.duration) > 1) {
      warnings.push(`source covers ${sourceFrames} frames at ${rateLabel(clip.file.rate ?? clip.rate)} fps, XML says ${clip.file.duration}`);
    }
    if (range.head < opts.handles) warnings.push(`head handle clamped to ${range.head}`);
    if (range.tail < opts.handles) warnings.push(`tail handle clamped to ${range.tail}`);
    if (clip.effects.length) warnings.push(`timeline effects not baked in: ${clip.effects.join(', ')}`);
    if (clip.end - clip.start !== clip.out - clip.in) warnings.push('speed change on timeline is not applied');
    if (clip.warnings) warnings.push(...clip.warnings);

    for (const output of outputs) {
      const presetName = output.preset;
      const preset = presets[presetName];
      const vars = {
        clipName: clip.name,
        sourceFilename: path.parse(clip.file.name ?? clip.file.path).name,
        take: path.parse(clip.file.name ?? clip.file.path).name,
        shot: shotNumber(index),
        colorSpace: output.colorSpace ?? SPACE_LABEL[clip.inputSpace] ?? 'SOURCE',
        version: opts.version,
        compressionPreset: presetName,
        preset: presetName,
        frameRate: rateLabel(clip.file.rate ?? clip.rate),
        resolution: '',
        string: opts.string,
        handles: opts.handles,
        editSource,
        folder: path.basename(clip.dir ?? path.dirname(clip.file.path)),
      };
      const size = outputSize(probe ? { width: probe.width, height: probe.height } : { width: clip.file.width, height: clip.file.height }, output);
      vars.resolution = `${size.width}x${size.height}`;
      // files mode, "keep folder structure": the source's folder below the input, then the template
      const mirrored = opts.mirror && clip.relDir ? clip.relDir.split(/[\\/]+/).filter(Boolean) : [];
      const segments = [...mirrored, ...renderTemplate(opts.template, vars)];
      const job = { clip, index, shot: vars.shot, output, presetName, preset, range, probe, size, warnings, colorSpace: vars.colorSpace };
      if (preset.kind === 'sequence') {
        // Frames go in their own folder, named like the files: <name>/<name>.1001.exr
        const name = segments[segments.length - 1];
        job.outPath = path.join(opts.out, ...segments);
        // files mode keeps a source sequence's own frame numbers
        const start = opts.keepNumbers && clip.file.sequence ? clip.file.sequence.first : opts.startFrame ?? 1001;
        job.seq = { dir: job.outPath, name, ext: preset.ext, start, pad: Math.max(4, String(start + range.frames - 1).length) };
        job.displayPath = path.join(job.outPath, `${name}.${'#'.repeat(job.seq.pad)}.${preset.ext}`);
      } else {
        job.outPath = path.join(opts.out, ...segments) + '.' + preset.ext;
        job.displayPath = job.outPath;
      }
      jobs.push(job);
    }
  });
  return jobs;
}

export function findCollisions(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = j.outPath.toLowerCase();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(j);
  }
  return [...seen.values()].filter((list) => list.length > 1);
}
