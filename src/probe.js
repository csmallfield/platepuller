import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readVideoIndex } from './movindex.js';

const run = promisify(execFile);
const cache = new Map();

/**
 * Stream info plus the presentation timestamp of every video sample.
 *
 * Phone footage is often not exactly constant-rate (an iPhone "24p" clip can have a
 * 1/600 s longer frame every 49 frames). Premiere conforms it to the nominal rate and
 * addresses frames by time, so edit frame N is whichever sample is on screen at N/fps.
 */
export function probeSource(file, ffprobe = 'ffprobe') {
  if (!cache.has(file)) cache.set(file, doProbe(file, ffprobe));
  return cache.get(file);
}

/** Every video packet via ffprobe. Exact for any format, but reads the whole file. */
export async function probePackets(file, ffprobe = 'ffprobe') {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', file],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pts, dur] = l.split(',');
      return { pts: Number(pts), dur: Number(dur) };
    })
    .filter((p) => Number.isFinite(p.pts))
    .sort((a, b) => a.pts - b.pts);
}

async function doProbe(file, ffprobe) {
  const { stdout: info } = await run(ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,time_base,r_frame_rate,sample_rate,channels,color_space,color_primaries,color_transfer',
    '-of', 'json', file,
  ]);
  const meta = JSON.parse(info);
  const video = meta.streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${file}`);
  const audio = meta.streams.find((s) => s.codec_type === 'audio') ?? null;
  const [tbNum, tbDen] = video.time_base.split('/').map(Number);

  // Read timestamps from the container's sample table when we can; it is a few KB
  // instead of the whole file.
  const index = readVideoIndex(file);
  const samples = index && index.timeBase.den * tbNum === tbDen ? index.samples : await probePackets(file, ffprobe);

  const sec = (ticks) => (ticks * tbNum) / tbDen;
  const last = samples[samples.length - 1];
  return {
    file,
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    nominalRate: video.r_frame_rate,
    colorSpace: video.color_space,
    colorPrimaries: video.color_primaries,
    colorTransfer: video.color_transfer,
    audio: audio ? { channels: audio.channels, sampleRate: Number(audio.sample_rate) } : null,
    timeBase: { num: tbNum, den: tbDen },
    samples,
    firstTime: sec(samples[0].pts),
    endTime: sec(last.pts + (last.dur || 0)),
  };
}

/** Number of frames at `fps` the source covers. Premiere rounds the duration to the nearest frame. */
export function framesAtRate(probe, fps) {
  return Math.round((probe.endTime - probe.firstTime) * fps);
}
