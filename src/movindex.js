// Frame timestamps straight from a QuickTime / MP4 sample table (moov atom), without
// reading the media data. Listing packets with ffprobe reads the whole file, which for
// multi-GB camera originals on a cold disk takes minutes.
import fs from 'node:fs';

function readBoxes(buf, start = 0, end = buf.length) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    boxes.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return boxes;
}

const find = (buf, box, type) => readBoxes(buf, box.start, box.end).find((b) => b.type === type);
const findAll = (buf, box, type) => readBoxes(buf, box.start, box.end).filter((b) => b.type === type);

function readMoov(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let p = 0;
    while (p + 8 <= size) {
      fs.readSync(fd, head, 0, 16, p);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        boxSize = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - p;
      }
      if (boxSize < header) return null;
      if (type === 'moov') {
        const buf = Buffer.alloc(boxSize - header);
        fs.readSync(fd, buf, 0, buf.length, p + header);
        return buf;
      }
      p += boxSize;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Returns { timeBase: {num, den}, samples: [{pts, dur}] } for the first video track,
 * with timestamps as ffmpeg reports them, or null if the file needs the slow path.
 */
export function readVideoIndex(file) {
  if (!/\.(mov|mp4|m4v)$/i.test(file)) return null;
  const moov = readMoov(file);
  if (!moov) return null;
  const root = { start: 0, end: moov.length };

  for (const trak of findAll(moov, root, 'trak')) {
    const mdia = find(moov, trak, 'mdia');
    const hdlr = mdia && find(moov, mdia, 'hdlr');
    if (!hdlr || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;

    const mdhd = find(moov, mdia, 'mdhd');
    const v = moov[mdhd.start];
    const timescale = moov.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
    const minf = find(moov, mdia, 'minf');
    const stbl = minf && find(moov, minf, 'stbl');
    if (!stbl) return null;
    const stts = find(moov, stbl, 'stts');
    if (!stts) return null;

    // decode times from stts
    const durs = [];
    const n = moov.readUInt32BE(stts.start + 4);
    for (let i = 0; i < n; i++) {
      const count = moov.readUInt32BE(stts.start + 8 + i * 8);
      const delta = moov.readUInt32BE(stts.start + 12 + i * 8);
      for (let k = 0; k < count; k++) durs.push(delta);
    }
    // composition offsets (B-frames) - not handled here, take the exact path instead
    if (find(moov, stbl, 'ctts')) return null;

    // edit list: only the trivial "play the whole media from 0" case; anything else changes
    // which samples ffmpeg presents, so take the exact path.
    const edts = find(moov, trak, 'edts');
    const elst = edts && find(moov, edts, 'elst');
    if (elst) {
      const ver = moov[elst.start];
      const entries = moov.readUInt32BE(elst.start + 4);
      const media = [];
      for (let i = 0; i < entries; i++) {
        const o = elst.start + 8 + i * (ver === 1 ? 20 : 12);
        const mediaTime = ver === 1 ? Number(moov.readBigInt64BE(o + 8)) : moov.readInt32BE(o + 4);
        media.push(mediaTime);
      }
      if (media.length !== 1 || media[0] !== 0) return null;
    }

    let t = 0;
    const samples = durs.map((dur) => {
      const s = { pts: t, dur };
      t += dur;
      return s;
    });
    return { timeBase: { num: 1, den: timescale }, samples };
  }
  return null;
}
