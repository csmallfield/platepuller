'use strict';

const TOKEN = document.querySelector('meta[name="platepuller-token"]').content;
const STORE = 'platepuller.settings.v2'; // v2: exposure is in stops (v1 stored the curve's 0.6 scale)
const $ = (id) => document.getElementById(id);

let meta;
let state;
let plan = null;
let planSeq = 0;
let planTimer = null;
let busy = false;
let events = null;
let progress = new Map(); // job id -> fraction done

// ---- helpers ------------------------------------------------------------------------

async function api(name, body = {}) {
  const r = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Platepuller-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved) return saved;
    const v1 = JSON.parse(localStorage.getItem('platepuller.settings.v1'));
    if (v1?.outputs) for (const o of v1.outputs) o.exposure = 0;
    return v1 || null;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* storage unavailable: settings just won't be remembered */
  }
}

function autoColorSpace(o) {
  return { none: 'LOG', 'applelog-acescg': 'ACESCG' }[o.color] ?? 'REC709';
}

// ---- form ---------------------------------------------------------------------------

const SIMPLE = [
  ['xml', 'xml'],
  ['out', 'out'],
  ['template', 'template'],
  ['version-input', 'version'],
  ['string', 'string'],
  ['handles', 'handles'],
  ['startFrame', 'startFrame'],
  ['frameMatch', 'frameMatch'],
  ['jobs', 'jobs'],
];

function bindForm() {
  for (const [id, key] of SIMPLE) {
    const input = $(id);
    input.value = state[key] ?? '';
    input.addEventListener('input', () => {
      state[key] = input.type === 'number' ? Number(input.value) : input.value;
      changed();
    });
  }
  $('includeDisabled').checked = Boolean(state.includeDisabled);
  $('includeDisabled').addEventListener('change', (e) => {
    state.includeDisabled = e.target.checked;
    changed();
  });
  for (const r of document.querySelectorAll('input[name="existing"]')) {
    r.checked = r.value === state.existing;
    r.addEventListener('change', () => {
      state.existing = r.value;
      changed();
    });
  }
  for (const btn of document.querySelectorAll('[data-pick]')) {
    btn.addEventListener('click', async () => {
      const input = $(btn.dataset.target);
      const p = await pickPath(btn.dataset.pick, input.value || (btn.dataset.pick === 'folder' ? plan?.out : '') || '');
      if (p) {
        input.value = p;
        input.dispatchEvent(new Event('input'));
      }
    });
  }

  // frame matching options
  for (const [k, d] of Object.entries(meta.frameMatch)) $('frameMatch').append(el('option', { value: k, text: k }));
  $('frameMatch').value = state.frameMatch;
  const fmHint = () => ($('frameMatch-hint').textContent = `Frame matching “${state.frameMatch}”: ${meta.frameMatch[state.frameMatch] ?? ''}.`);
  $('frameMatch').addEventListener('change', fmHint);
  fmHint();

  // template variable chips, inserted at the cursor
  const tpl = $('template');
  for (const [name, desc] of Object.entries(meta.variables)) {
    $('chips').append(
      el('button', {
        type: 'button',
        class: 'chip',
        title: desc,
        text: `{${name}}`,
        onmousedown: (e) => e.preventDefault(), // keep the caret in the template field
        onclick: () => {
          const token = `{${name}}`;
          const start = tpl.selectionStart ?? tpl.value.length;
          const end = tpl.selectionEnd ?? start;
          tpl.setRangeText(token, start, end, 'end');
          tpl.focus();
          tpl.dispatchEvent(new Event('input'));
        },
      }),
    );
  }

  $('add-output').addEventListener('click', () => {
    const last = state.outputs[state.outputs.length - 1] ?? meta.defaults.output;
    state.outputs.push({ ...last });
    renderOutputs();
    changed();
  });
  $('publish').addEventListener('click', publish);
  $('cancel').addEventListener('click', () => api('cancel').catch(showFatal));
}

async function pickPath(kind, initial) {
  try {
    return (await api('pick', { kind, initial })).path;
  } catch (err) {
    showFatal(err);
    return null;
  }
}

function renderOutputs() {
  const wrap = $('outputs');
  wrap.textContent = '';
  const tpl = $('output-tpl');
  state.outputs.forEach((o, i) => {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const presetSel = card.querySelector('[data-k="preset"]');
    for (const [kind, label] of [['movie', 'Movies'], ['sequence', 'Image sequences']]) {
      const group = el('optgroup', { label });
      for (const [name, p] of Object.entries(meta.presets)) {
        if ((p.kind ?? 'movie') === kind) group.append(el('option', { value: name, text: `${name}  (.${p.ext})` }));
      }
      if (group.children.length) presetSel.append(group);
    }
    const fill = (k, entries) => {
      const sel = card.querySelector(`[data-k="${k}"]`);
      for (const [value, text] of Object.entries(entries)) sel.append(el('option', { value, text }));
    };
    fill('color', meta.colorModes);
    fill('scale', meta.scales);
    fill('exrCompression', meta.exrCompression);

    const refresh = () => {
      const p = meta.presets[o.preset];
      const title = card.querySelector('.output-title');
      title.textContent = `Output ${i + 1}`;
      const res = o.scale === 'custom' ? `${o.width}px wide` : o.scale === 'full' ? '' : `${o.scale} res`;
      const bits = [o.preset, p?.kind === 'sequence' ? `.${p.ext} sequence` : `.${p?.ext ?? '?'}`, o.colorSpace || autoColorSpace(o), res, o.alpha && p?.alphaPixFmt ? 'alpha' : ''];
      title.append(el('small', { text: bits.filter(Boolean).join(' · ') }));
      card.querySelector('.preset-desc').textContent = p?.description ?? '';
      for (const f of card.querySelectorAll('[data-show-color]')) f.hidden = !f.dataset.showColor.split(' ').includes(o.color);
      for (const f of card.querySelectorAll('[data-show-scale]')) f.hidden = f.dataset.showScale !== o.scale;
      for (const f of card.querySelectorAll('[data-show-ext]')) f.hidden = f.dataset.showExt !== p?.ext;
      for (const f of card.querySelectorAll('[data-show-alpha]')) f.hidden = !p?.alphaPixFmt;
      card.querySelector('[data-k="colorSpace"]').placeholder = `${autoColorSpace(o)} (automatic)`;
    };

    for (const input of card.querySelectorAll('[data-k]')) {
      const k = input.dataset.k;
      if (input.type === 'checkbox') input.checked = Boolean(o[k]);
      else input.value = o[k] ?? '';
      input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => {
        o[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        refresh();
        changed();
      });
    }
    card.querySelector('[data-act="pick-lut"]').addEventListener('click', async () => {
      const p = await pickPath('lut', o.lut);
      if (p) {
        const input = card.querySelector('[data-k="lut"]');
        input.value = p;
        input.dispatchEvent(new Event('input'));
      }
    });
    const remove = card.querySelector('[data-act="remove"]');
    remove.disabled = state.outputs.length === 1;
    remove.addEventListener('click', () => {
      state.outputs.splice(i, 1);
      renderOutputs();
      changed();
    });
    card.querySelector('[data-act="dup"]').addEventListener('click', () => {
      state.outputs.splice(i + 1, 0, { ...o });
      renderOutputs();
      changed();
    });
    refresh();
    wrap.append(card);
  });
}

function setBusy(on) {
  busy = on;
  for (const e of document.querySelectorAll('main input, main select, main button, .add-output')) {
    if (!e.closest('#sec-progress')) e.disabled = on;
  }
  if (!on) renderOutputs(); // restores per-card disabled states
  $('cancel').hidden = !on;
  $('publish').hidden = on;
}

// ---- planning -----------------------------------------------------------------------

function changed() {
  save();
  clearTimeout(planTimer);
  $('plan-status').textContent = 'Checking…';
  planTimer = setTimeout(refreshPlan, 350);
}

async function refreshPlan() {
  const seq = ++planSeq;
  try {
    const p = await api('plan', { settings: state });
    if (seq !== planSeq) return;
    plan = p;
    renderPlan();
  } catch (err) {
    if (seq === planSeq) showFatal(err);
  }
}

function renderPlan() {
  const p = plan;
  // edit summary + clips
  const hasEdit = Boolean(p.sequenceName);
  $('edit-summary').hidden = !hasEdit;
  $('clips-wrap').hidden = !p.clips.length;
  if (hasEdit) {
    $('edit-summary').textContent = '';
    $('edit-summary').append(el('strong', { text: p.sequenceName }), ` · ${p.clips.length} clip${p.clips.length === 1 ? '' : 's'}`, ...p.notes.map((n) => el('div', { text: n })));
  }
  $('clips').textContent = '';
  for (const c of p.clips) {
    $('clips').append(
      el('tr', {},
        el('td', { text: c.shot ?? '' }),
        el('td', { text: c.name }),
        el('td', { text: c.source, title: c.sourcePath }),
        el('td', { class: 'r', text: c.in }),
        el('td', { class: 'r', text: c.out }),
        el('td', { class: 'r', text: c.duration }),
        el('td', { class: 'r', text: c.head == null ? '' : `${c.head} / ${c.tail}` }),
        el('td', { class: 'notes', text: c.warnings.join('; ') }),
      ),
    );
  }

  // example names: first clip, every output
  $('examples').textContent = '';
  const first = p.jobs.filter((j) => j.clip === 0);
  for (const j of first) {
    $('examples').append(
      el('div', { class: 'example' }, el('b', { text: `Output ${j.output + 1}` }), j.rel, j.frameRange ? el('b', { text: `  frames ${j.frameRange}` }) : null),
    );
  }
  if (p.out && first.length) $('examples').append(el('div', { class: 'hint', text: `in ${p.out}` }));

  // status + errors
  const errs = p.errors.filter((e) => e !== 'Choose an edit XML');
  $('errors').textContent = '';
  for (const e of errs) $('errors').append(el('li', { text: e }));
  const todo = p.jobs.filter((j) => j.status === 'todo').length;
  const kept = p.jobs.filter((j) => j.status === 'kept').length;
  const status = $('plan-status');
  status.textContent = '';
  if (!state.xml) status.textContent = 'Choose an edit XML to begin.';
  else if (p.jobs.length) {
    const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    status.append(el('strong', { text: n(todo, 'file') }), ` to publish — ${n(p.clips.length, 'clip')} × ${n(p.outputs.length, 'output')}`);
    if (kept) status.append(`, ${kept} existing kept`);
  }
  $('publish').disabled = busy || errs.length > 0 || !state.xml || todo === 0;
}

// ---- publishing ---------------------------------------------------------------------

async function publish() {
  setBusy(true);
  $('errors').textContent = '';
  try {
    events?.close();
    await api('run', { settings: state });
    listen();
  } catch (err) {
    setBusy(false);
    showFatal(err);
  }
}

function listen() {
  events = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  events.onmessage = (m) => onEvent(JSON.parse(m.data));
}

function updateOverall() {
  const total = progress.size;
  const sum = [...progress.values()].reduce((a, b) => a + b, 0);
  $('overall-bar').style.width = total ? `${(sum / total) * 100}%` : '0';
}

function setRow(id, status, fraction) {
  const row = document.querySelector(`#progress tr[data-id="${id}"]`);
  if (!row) return;
  if (fraction != null) row.querySelector('.bar > div').style.width = `${Math.min(1, fraction) * 100}%`;
  if (status) {
    const st = row.querySelector('.st');
    st.className = `st ${status}`;
    st.textContent = { ok: 'Done', failed: 'Failed', cancelled: 'Cancelled', running: 'Encoding', queued: 'Queued', kept: 'Kept' }[status] ?? status;
  }
}

function onEvent(e) {
  switch (e.type) {
    case 'plan': {
      progress = new Map();
      $('sec-progress').hidden = false;
      $('results').textContent = '';
      $('progress').textContent = '';
      for (const j of e.plan.jobs) {
        const c = e.plan.clips[j.clip];
        const o = e.plan.outputs[j.output];
        if (j.status === 'todo') progress.set(j.id, 0);
        $('progress').append(
          el('tr', { 'data-id': j.id },
            el('td', { text: c.shot }),
            el('td', { text: c.name }),
            el('td', { text: `${j.output + 1} · ${o.preset}` }),
            el('td', { class: 'file', text: j.frameRange ? `${j.rel}  (${j.frameRange})` : j.rel }),
            el('td', { class: 'w-bar' }, el('div', { class: 'bar' }, el('div'))),
            el('td', {}, el('span', { class: 'st' })),
          ),
        );
        setRow(j.id, j.status === 'todo' ? 'queued' : j.status, j.status === 'kept' ? 1 : 0);
      }
      if (busy) $('sec-progress').scrollIntoView({ behavior: 'smooth', block: 'start' }); // not when replaying after a reload
      break;
    }
    case 'start':
      $('overall-text').textContent = `0 / ${e.total} files`;
      if (!busy) setBusy(true);
      break;
    case 'job-start':
      setRow(e.id, 'running');
      break;
    case 'job-progress':
      progress.set(e.id, e.frame / e.frames);
      setRow(e.id, null, e.frame / e.frames);
      updateOverall();
      break;
    case 'job-done':
      progress.set(e.id, 1);
      setRow(e.id, e.status, e.status === 'ok' ? 1 : undefined);
      if (e.error) document.querySelector(`#progress tr[data-id="${e.id}"] .st`).title = e.error;
      $('overall-text').textContent = `${e.done} / ${e.total} files`;
      updateOverall();
      break;
    case 'job-skipped':
      setRow(e.id, e.status);
      break;
    case 'file':
      if (e.kind === 'xml-skipped') $('results').append(el('div', { class: 'result' }, `No processed XML for output ${e.output + 1}: ${e.reason}.`));
      else addResult(e.kind === 'xml' ? `Processed XML (output ${e.output + 1})` : 'Report', e.path);
      break;
    case 'done': {
      const parts = [];
      if (e.failed) parts.push(`${e.failed} failed`);
      if (e.cancelled) parts.push(`${e.cancelled} cancelled`);
      $('results').prepend(addResult(parts.length ? `Finished with ${parts.join(', ')}` : 'All done', e.out, true));
      break;
    }
    case 'error':
      $('results').append(el('div', { class: 'result st failed', text: e.message }));
      break;
    case 'end':
      events?.close();
      setBusy(false);
      changed();
      break;
  }
}

function addResult(label, p, detached = false) {
  const row = el('div', { class: 'result' },
    el('strong', { text: label }),
    el('code', { text: p }),
    el('button', { type: 'button', class: 'btn link', text: 'Show', onclick: () => api('reveal', { path: p }).catch(showFatal) }),
  );
  if (!detached) $('results').append(row);
  return row;
}

function showFatal(err) {
  $('errors').textContent = '';
  $('errors').append(el('li', { text: err.message }));
}

// ---- start --------------------------------------------------------------------------

async function init() {
  meta = await api('meta');
  $('version').textContent = `v${meta.version}`;
  const d = meta.defaults;
  const saved = loadSaved() ?? {};
  state = {
    xml: '',
    out: '',
    template: d.template,
    version: d.version,
    string: d.string,
    handles: d.handles,
    startFrame: d.startFrame,
    frameMatch: d.frameMatch,
    jobs: d.jobs,
    existing: d.existing,
    includeDisabled: d.includeDisabled,
    ...saved,
  };
  state.outputs = (saved.outputs?.length ? saved.outputs : [d.output]).map((o) => ({ ...d.output, ...o }))
    .filter((o) => meta.presets[o.preset]);
  if (!state.outputs.length) state.outputs = [{ ...d.output }];
  bindForm();
  renderOutputs();
  refreshPlan();
  listen(); // shows a publish that is still running (or just finished) after a reload
}

init().catch(showFatal);
