// Read and rewrite Final Cut Pro 7 XML (xmeml) as exported by Premiere Pro.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TICKS_PER_SECOND = 254016000000;

export function parseXmeml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'xmeml') throw new Error('Not an xmeml (Final Cut Pro 7 XML) file.');
  return doc;
}

export function serializeXmeml(doc) {
  let out = new XMLSerializer().serializeToString(doc);
  if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  return out;
}

// ---- small DOM helpers ----------------------------------------------------

export function children(el, tag) {
  const out = [];
  for (let n = el?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tag || n.tagName === tag)) out.push(n);
  }
  return out;
}

export function child(el, tag) {
  return children(el, tag)[0] ?? null;
}

export function childPath(el, ...tags) {
  let cur = el;
  for (const t of tags) {
    cur = child(cur, t);
    if (!cur) return null;
  }
  return cur;
}

export function text(el) {
  return el ? el.textContent.trim() : null;
}

function num(el) {
  const t = text(el);
  return t === null || t === '' ? null : Number(t);
}

function setText(el, value) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument.createTextNode(String(value)));
}

function setChildText(el, tag, value) {
  let c = child(el, tag);
  if (!c) {
    c = el.ownerDocument.createElement(tag);
    el.appendChild(c);
  }
  setText(c, value);
  return c;
}

// ---- rates and paths ------------------------------------------------------

export function readRate(el) {
  const r = child(el, 'rate');
  if (!r) return null;
  return { timebase: num(child(r, 'timebase')), ntsc: text(child(r, 'ntsc'))?.toUpperCase() === 'TRUE' };
}

export function rateFps(rate) {
  return rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
}

export function rateLabel(rate) {
  if (!rate.ntsc) return String(rate.timebase);
  return (Math.round(rateFps(rate) * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function ticksForFrames(frames, rate) {
  return Math.round((frames * TICKS_PER_SECOND) / rateFps(rate));
}

export function pathFromPathurl(pathurl) {
  // Premiere writes file://localhost/D%3a/dir/file.mov
  const normalized = pathurl.replace(/^file:\/\/localhost\//i, 'file:///');
  return fileURLToPath(normalized);
}

export function pathurlFromPath(p) {
  const posix = path.resolve(p).replace(/\\/g, '/');
  const segments = posix.split('/').map((s) => encodeURIComponent(s).replace(/%3A/g, '%3a'));
  const joined = segments.join('/');
  return 'file://localhost' + (joined.startsWith('/') ? '' : '/') + joined;
}

export function framesToTimecode(frames, rate, dropFrame = false) {
  const fps = rate.timebase;
  let f = frames;
  if (dropFrame && rate.ntsc && (fps === 30 || fps === 60)) {
    const drop = fps === 30 ? 2 : 4;
    const perMin = fps * 60 - drop;
    const per10 = perMin * 10 + drop;
    const d = Math.floor(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = f % fps;
  const totalSec = Math.floor(f / fps);
  const pad = (n) => String(n).padStart(2, '0');
  const sep = dropFrame ? ';' : ':';
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}${sep}${pad(ff)}`;
}

// ---- reading clips --------------------------------------------------------

function fileDefinitions(doc) {
  const defs = new Map();
  for (const f of Array.from(doc.getElementsByTagName('file'))) {
    if (child(f, 'pathurl')) defs.set(f.getAttribute('id'), f);
  }
  return defs;
}

function readFile(fileEl) {
  const pathurl = text(child(fileEl, 'pathurl'));
  const tc = child(fileEl, 'timecode');
  const vchar = childPath(fileEl, 'media', 'video', 'samplecharacteristics');
  return {
    id: fileEl.getAttribute('id'),
    name: text(child(fileEl, 'name')),
    pathurl,
    path: pathurl ? pathFromPathurl(pathurl) : null,
    duration: num(child(fileEl, 'duration')),
    rate: readRate(fileEl),
    timecodeFrame: tc ? num(child(tc, 'frame')) ?? 0 : 0,
    dropFrame: tc ? text(child(tc, 'displayformat')) === 'DF' : false,
    width: vchar ? num(child(vchar, 'width')) : null,
    height: vchar ? num(child(vchar, 'height')) : null,
  };
}

function effectNames(clipEl) {
  return children(clipEl, 'filter')
    .flatMap((f) => children(f, 'effect'))
    .map((e) => text(child(e, 'effectid')) || text(child(e, 'name')))
    .filter(Boolean);
}

/**
 * Every video clipitem that points at a media file, in timeline order.
 * Returns plain objects that keep a reference to their DOM element.
 */
export function readVideoClips(doc) {
  const sequence = childPath(doc.documentElement, 'sequence');
  if (!sequence) throw new Error('No <sequence> found at the top level of the XML.');
  const seqRate = readRate(sequence);
  const defs = fileDefinitions(doc);
  const byId = new Map(Array.from(doc.getElementsByTagName('clipitem')).map((c) => [c.getAttribute('id'), c]));

  const videoTracks = children(childPath(sequence, 'media', 'video'), 'track');
  const clips = [];
  const skipped = [];
  videoTracks.forEach((track, ti) => {
    for (const el of children(track, 'clipitem')) {
      const name = text(child(el, 'name'));
      const fileRef = child(el, 'file');
      if (!fileRef) {
        skipped.push({ name, reason: 'no media file (nested sequence, generator or graphic)' });
        continue;
      }
      const fileEl = defs.get(fileRef.getAttribute('id'));
      if (!fileEl) {
        skipped.push({ name, reason: `file id ${fileRef.getAttribute('id')} has no definition` });
        continue;
      }
      const linkedAudio = children(el, 'link')
        .filter((l) => text(child(l, 'mediatype')) === 'audio')
        .map((l) => byId.get(text(child(l, 'linkclipref'))))
        .filter(Boolean);

      clips.push({
        id: el.getAttribute('id'),
        element: el,
        linkedAudio,
        name,
        enabled: text(child(el, 'enabled'))?.toUpperCase() !== 'FALSE',
        track: ti + 1,
        start: num(child(el, 'start')),
        end: num(child(el, 'end')),
        in: num(child(el, 'in')),
        out: num(child(el, 'out')),
        rate: readRate(el) ?? seqRate,
        effects: effectNames(el),
        file: readFile(fileEl),
      });
    }
  });

  clips.sort((a, b) => a.start - b.start || a.track - b.track);
  return {
    sequenceName: text(child(sequence, 'name')),
    sequenceRate: seqRate,
    clips,
    skipped,
  };
}

// ---- writing the processed XML --------------------------------------------

function buildFileElement(doc, id, o) {
  const tpl = `<file id="${id}">
  <name/><pathurl/>
  <rate><timebase/><ntsc/></rate>
  <duration/>
  <timecode><rate><timebase/><ntsc/></rate><string/><frame/><displayformat/></timecode>
  <media>
    <video><samplecharacteristics><rate><timebase/><ntsc/></rate><width/><height/><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>
  </media>
</file>`;
  const el = doc.importNode(new DOMParser().parseFromString(tpl, 'text/xml').documentElement, true);
  const ntsc = o.rate.ntsc ? 'TRUE' : 'FALSE';
  setText(child(el, 'name'), o.name);
  setText(child(el, 'pathurl'), o.pathurl);
  setText(childPath(el, 'rate', 'timebase'), o.rate.timebase);
  setText(childPath(el, 'rate', 'ntsc'), ntsc);
  setText(child(el, 'duration'), o.duration);
  const tc = child(el, 'timecode');
  setText(childPath(tc, 'rate', 'timebase'), o.rate.timebase);
  setText(childPath(tc, 'rate', 'ntsc'), ntsc);
  setText(child(tc, 'string'), framesToTimecode(o.timecodeFrame, o.rate, o.dropFrame));
  setText(child(tc, 'frame'), o.timecodeFrame);
  setText(child(tc, 'displayformat'), o.dropFrame ? 'DF' : 'NDF');
  const sc = childPath(el, 'media', 'video', 'samplecharacteristics');
  setText(childPath(sc, 'rate', 'timebase'), o.rate.timebase);
  setText(childPath(sc, 'rate', 'ntsc'), ntsc);
  setText(child(sc, 'width'), o.width);
  setText(child(sc, 'height'), o.height);
  if (o.audioChannels) {
    const audio = new DOMParser().parseFromString(
      `<audio><samplecharacteristics><depth>16</depth><samplerate>${o.audioSampleRate || 48000}</samplerate></samplecharacteristics><channelcount>${o.audioChannels}</channelcount></audio>`,
      'text/xml',
    ).documentElement;
    child(el, 'media').appendChild(doc.importNode(audio, true));
  }
  return el;
}

function retimeClipitem(el, inFrame, outFrame, duration, rate, fileId, masterclipId) {
  setChildText(el, 'in', inFrame);
  setChildText(el, 'out', outFrame);
  setChildText(el, 'duration', duration);
  if (child(el, 'pproTicksIn')) setChildText(el, 'pproTicksIn', ticksForFrames(inFrame, rate));
  if (child(el, 'pproTicksOut')) setChildText(el, 'pproTicksOut', ticksForFrames(outFrame, rate));
  if (child(el, 'masterclipid')) setChildText(el, 'masterclipid', masterclipId);
  const old = child(el, 'file');
  const ref = el.ownerDocument.createElement('file');
  ref.setAttribute('id', fileId);
  el.replaceChild(ref, old);
  return old;
}

/**
 * Relink each published clip to its new file in a copy of the XML.
 * `published` items: { clip, outPath, outFrames, headHandle, timecodeFrame, width, height, audioChannels, audioSampleRate }
 */
export function writeProcessedXml(originalText, published, { sequenceSuffix = '_processed' } = {}) {
  const doc = parseXmeml(originalText);
  const byId = new Map(Array.from(doc.getElementsByTagName('clipitem')).map((c) => [c.getAttribute('id'), c]));
  const removedDefs = new Map();

  published.forEach((p, i) => {
    const el = byId.get(p.clip.id);
    if (!el) throw new Error(`clipitem ${p.clip.id} not found while writing processed XML`);
    const fileId = `file-publish-${i + 1}`;
    const masterclipId = `masterclip-publish-${i + 1}`;
    const rate = p.clip.rate;
    const inFrame = p.headHandle;
    const outFrame = p.headHandle + (p.clip.out - p.clip.in);

    const old = retimeClipitem(el, inFrame, outFrame, p.outFrames, rate, fileId, masterclipId);
    if (child(old, 'pathurl')) removedDefs.set(old.getAttribute('id'), old);
    const fileEl = buildFileElement(doc, fileId, {
      name: path.basename(p.outPath),
      pathurl: pathurlFromPath(p.outPath),
      rate: p.clip.file.rate ?? rate,
      duration: p.outFrames,
      timecodeFrame: p.timecodeFrame,
      dropFrame: p.clip.file.dropFrame,
      width: p.width,
      height: p.height,
      audioChannels: p.audioChannels,
      audioSampleRate: p.audioSampleRate,
    });
    el.replaceChild(fileEl, child(el, 'file'));

    // Linked audio clipitems from the same media follow the video.
    for (const l of children(el, 'link')) {
      if (text(child(l, 'mediatype')) !== 'audio') continue;
      const a = byId.get(text(child(l, 'linkclipref')));
      const aFile = a && child(a, 'file');
      if (!aFile || aFile.getAttribute('id') !== old.getAttribute('id')) continue;
      if (!p.audioChannels) continue; // published file has no audio; leave the original audio in place
      const aOld = retimeClipitem(a, inFrame, outFrame, p.outFrames, rate, fileId, masterclipId);
      if (child(aOld, 'pathurl')) removedDefs.set(aOld.getAttribute('id'), aOld);
    }
  });

  // A file definition we replaced may still be referenced by clips we did not touch
  // (disabled clips, audio-only uses). Put the full definition back on the first such reference.
  for (const [id, def] of removedDefs) {
    const refs = Array.from(doc.getElementsByTagName('file')).filter((f) => f.getAttribute('id') === id);
    if (refs.length && !refs.some((r) => child(r, 'pathurl'))) {
      refs[0].parentNode.replaceChild(def, refs[0]);
    }
  }

  const seqName = childPath(doc.documentElement, 'sequence', 'name');
  if (seqName) setText(seqName, text(seqName) + sequenceSuffix);
  const uuid = childPath(doc.documentElement, 'sequence', 'uuid');
  if (uuid) uuid.parentNode.removeChild(uuid);

  return serializeXmeml(doc);
}
