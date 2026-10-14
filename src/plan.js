// Turn an edit + options into a list of encode jobs.
import path from 'node:path';
import { rateFps, rateLabel } from './xmeml.js';
import { framesAtRate } from './probe.js';
import { renderTemplate } from './template.js';

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

    for (const output of outputs) {
      const presetName = output.preset;
      const preset = presets[presetName];
      const vars = {
        clipName: clip.name,
        sourceFilename: path.parse(clip.file.name ?? clip.file.path).name,
        take: path.parse(clip.file.name ?? clip.file.path).name,
        shot: shotNumber(index),
        colorSpace: output.colorSpace,
        version: opts.version,
        compressionPreset: presetName,
        preset: presetName,
        frameRate: rateLabel(clip.file.rate ?? clip.rate),
        resolution: probe ? `${probe.width}x${probe.height}` : `${clip.file.width}x${clip.file.height}`,
        string: opts.string,
        handles: opts.handles,
        editSource,
      };
      const segments = renderTemplate(opts.template, vars);
      const outPath = path.join(opts.out, ...segments) + '.' + preset.ext;
      jobs.push({ clip, index, shot: vars.shot, output, presetName, preset, range, probe, outPath, warnings });
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
