// Core: a tiny virtual DOM, global state, API client and shared helpers.

const SVGNS = 'http://www.w3.org/2000/svg';

export function h(t, p, ...c) {
  return { t, p: p || {}, c: normChildren(c) };
}

function normChildren(c) {
  const out = [];
  (function add(x) {
    if (x == null || x === false || x === true) return;
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (typeof x === 'object') { out.push(x); return; }
    out.push({ t: '#', v: String(x), p: {} });
  })(c);
  return out;
}

function setProp(el, k, v, old, svg) {
  if (k === 'key' || k === 'ref' || k === 'mount') return;
  if (k.startsWith('on')) { el[k.toLowerCase()] = v || null; return; }
  if (k === 'class') { if (svg) el.setAttribute('class', v || ''); else el.className = v || ''; return; }
  if (k === 'style') { el.style.cssText = v || ''; return; }
  if (k === 'html') { if (v !== old) el.innerHTML = v || ''; return; }
  if (!svg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'indeterminate' || k === 'scrollTop')) {
    if (k === 'value') { const s = v == null ? '' : String(v); if (el.value !== s) el.value = s; }
    else if (el[k] !== !!v && k !== 'scrollTop') el[k] = !!v;
    else if (k === 'scrollTop' && v != null && el.scrollTop !== v) el.scrollTop = v;
    return;
  }
  if (v == null || v === false) el.removeAttribute(k);
  else el.setAttribute(k, v === true ? '' : v);
}

function create(v, svg) {
  if (v.t === '#') { v.el = document.createTextNode(v.v); return v.el; }
  svg = svg || v.t === 'svg';
  v.svg = svg;
  const el = svg ? document.createElementNS(SVGNS, v.t) : document.createElement(v.t);
  v.el = el;
  for (const k in v.p) setProp(el, k, v.p[k], undefined, svg);
  for (const ch of v.c) el.appendChild(create(ch, svg && v.t !== 'foreignObject'));
  if (v.p.mount) queueMicrotask(() => v.p.mount(el));
  if (v.p.ref) v.p.ref(el);
  return el;
}

function patch(parent, o, n) {
  if (o.t !== n.t || o.p.key !== n.p.key) {
    const el = create(n, o.svg);
    parent.replaceChild(el, o.el);
    return;
  }
  n.el = o.el;
  if (n.t === '#') { if (o.v !== n.v) o.el.nodeValue = n.v; return; }
  n.svg = o.svg;
  const keys = new Set([...Object.keys(o.p), ...Object.keys(n.p)]);
  for (const k of keys) {
    const ov = o.p[k], nv = n.p[k];
    if (ov !== nv || k === 'value' || k === 'checked') setProp(o.el, k, nv, ov, o.svg);
  }
  if (n.p.ref) n.p.ref(o.el);
  if (n.p.html == null) patchChildren(o.el, o.c, n.c, o.svg && n.t !== 'foreignObject');
}

function patchChildren(el, oc, nc, svg) {
  const keyed = nc.length && nc.some(c => c.p.key != null);
  if (!keyed) {
    const min = Math.min(oc.length, nc.length);
    for (let i = 0; i < min; i++) patch(el, oc[i], nc[i]);
    for (let i = min; i < nc.length; i++) el.appendChild(create(nc[i], svg));
    for (let i = oc.length - 1; i >= min; i--) if (oc[i].el.parentNode === el) el.removeChild(oc[i].el);
    return;
  }
  const map = new Map();
  for (const c of oc) if (c.p.key != null) map.set(c.p.key, c);
  const used = new Set();
  let ref = el.firstChild;
  for (const n of nc) {
    const o = n.p.key != null ? map.get(n.p.key) : null;
    if (o && !used.has(o) && o.t === n.t) { used.add(o); patch(el, o, n); }
    else create(n, svg);
    if (n.el === ref) ref = ref.nextSibling;
    else el.insertBefore(n.el, ref);
  }
  for (const o of oc) if (!used.has(o) && o.el.parentNode === el) el.removeChild(o.el);
}

let rootEl = null, rootV = null, rootFn = null, queued = false;
export function mount(el, fn) { rootEl = el; rootFn = fn; renderNow(); }
function renderNow() {
  queued = false;
  const nv = rootFn();
  if (!rootV) rootEl.appendChild(create(nv));
  else patch(rootEl, rootV, nv);
  rootV = nv;
}
export function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(renderNow);
}

// ---------- state ----------

export const S = {
  token: '',
  boot: true,
  dead: '',
  connected: false,
  profile: null,
  profiles: [],
  settings: {},
  view: 'keys',
  cluster: null,
  clusterErr: '',
  toasts: [],
  modal: null,
};

// ---------- API ----------

export class ApiError extends Error {}

// hooks set by the shell (avoids circular imports)
export const hooks = { disconnect: null };

export async function api(path, body, opts = {}) {
  const init = { headers: { 'X-Token': S.token } };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (opts.signal) init.signal = opts.signal;
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Brak kontaktu z aplikacją – czy etcd-browser nadal działa?');
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok || (j && j.error)) {
    const msg = (j && j.error) || `Błąd HTTP ${r.status}`;
    if (r.status === 409 && msg.startsWith('brak połączenia')) { S.connected = false; S.cluster = null; update(); }
    throw new ApiError(msg);
  }
  return j;
}

export function q(params) {
  const s = new URLSearchParams();
  for (const k in params) if (params[k] !== undefined && params[k] !== null) s.set(k, params[k]);
  return s.toString();
}

export function fileURL(path, params) {
  return `${path}?${q({ ...params, t: S.token })}`;
}

// ---------- bytes ----------

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b) {
  const s = atob(b || '');
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
export const strToB64 = (s) => bytesToB64(te.encode(s));
export function bytesToText(u8) { try { return td.decode(u8); } catch { return null; } }
export function b64ToText(b) { return bytesToText(b64ToBytes(b)); }

export function hexdump(u8, max = 65536) {
  const lines = [];
  const n = Math.min(u8.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = u8.subarray(off, Math.min(off + 16, n));
    let hex = '', asc = '';
    for (let i = 0; i < 16; i++) {
      if (i < row.length) { hex += row[i].toString(16).padStart(2, '0') + ' '; asc += row[i] >= 32 && row[i] < 127 ? String.fromCharCode(row[i]) : '·'; }
      else hex += '   ';
      if (i === 7) hex += ' ';
    }
    lines.push(`<span class="o">${off.toString(16).padStart(8, '0')}</span>  ${hex} <span class="a">${esc(asc)}</span>`);
  }
  if (u8.length > max) lines.push(`<span class="o">… pokazano ${fmtSize(max)} z ${fmtSize(u8.length)}</span>`);
  return lines.join('\n');
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function highlightJSON(text) {
  if (text.length > 2_000_000) return esc(text);
  return esc(text).replace(/(&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) => {
      if (str) return colon ? `<span class="j-k">${str}</span><span class="j-p">${colon}</span>` : `<span class="j-s">${str}</span>`;
      if (lit) return `<span class="j-b">${lit}</span>`;
      return `<span class="j-n">${num}</span>`;
    });
}

// ---------- formatting ----------

const nf = new Intl.NumberFormat('pl-PL');
export const fmtNum = (n) => (n == null ? '–' : nf.format(n));
export function fmtSize(b) {
  if (b == null) return '–';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('pl-PL', { maximumFractionDigits: v < 10 ? 2 : 1 })} ${u[i]}`;
}
export function fmtDur(sec) {
  if (sec == null || sec < 0) return '–';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  if (hh < 48) return mm ? `${hh} h ${mm} min` : `${hh} h`;
  return `${Math.floor(hh / 24)} d ${hh % 24} h`;
}
export function fmtMs(ms) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} s`; }
export function plural(n, one, few, many) {
  const a = Math.abs(n), d = a % 10, dd = a % 100;
  if (a === 1) return one;
  if (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) return few;
  return many;
}
export const pl = (n, one, few, many) => `${fmtNum(n)} ${plural(n, one, few, many)}`;

// ---------- icons ----------

const P = {
  keys: '<circle cx="8" cy="15" r="4"/><path d="M11 12 20 3M17 6l2 2M14.5 8.5l1.6 1.6"/>',
  cluster: '<circle cx="12" cy="5.5" r="2.5"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M10.7 7.7 6.8 15.3M13.3 7.7l3.9 7.6M8 17.5h8"/>',
  maint: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  lease: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5.5 8 9s-8 4-8 9M16 3c0 5-8 5.5-8 9s8 4 8 9"/>',
  auth: '<path d="M12 3 19 6v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  watch: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  power: '<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17h.01"/>',
  folder: '<path d="M3 6.5h6l2 2h10V19H3z"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  crown: '<path d="M4 18h16M5 15 3 7l5 4 4-6 4 6 5-4-2 8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
};
export function icon(name, cls) {
  return h('svg', { class: 'ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', html: P[name] || '' });
}

// ---------- toasts & modals ----------

let toastId = 0;
export function toast(msg, kind = '') {
  const id = ++toastId;
  S.toasts = [...S.toasts, { id, msg, kind }];
  update();
  setTimeout(() => { S.toasts = S.toasts.filter((t) => t.id !== id); update(); }, kind === 'error' ? 9000 : 4000);
}
export const toastErr = (e) => toast(e && e.message ? e.message : String(e), 'error');

// openModal shows a modal; render(m) returns {title, body, actions, wide}. Resolves with m.result.
export function openModal(render, init = {}) {
  return new Promise((resolve) => {
    const m = { ...init, render, close(result) { if (S.modal === m) { S.modal = null; update(); } resolve(result); } };
    S.modal = m;
    update();
  });
}

// ask: confirmation dialog. With typeToConfirm the user must type that text.
export function ask({ title, message, confirm = 'Potwierdź', danger = false, typeToConfirm = '' }) {
  return openModal((m) => ({
    title,
    body: [
      typeof message === 'string' ? h('p', null, message) : message,
      typeToConfirm && h('label', { class: 'field' },
        h('span', null, 'Aby potwierdzić, wpisz ', h('b', { class: 'mono' }, typeToConfirm)),
        h('input', { class: 'input mono', value: m.typed || '', mount: (el) => el.focus(), onInput: (e) => { m.typed = e.target.value; update(); },
          onKeydown: (e) => { if (e.key === 'Enter' && m.typed === typeToConfirm) m.close(true); } })),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close(false) }, 'Anuluj'),
      h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), disabled: typeToConfirm && m.typed !== typeToConfirm,
        mount: (el) => { if (!typeToConfirm) el.focus(); }, onClick: () => m.close(true) }, confirm),
    ],
  }));
}

export function isProd() { return S.profile && S.profile.env === 'prod'; }

// confirmDanger asks for typing the profile name on production profiles.
export function confirmDanger(opts) {
  return ask({ ...opts, danger: true, typeToConfirm: isProd() ? S.profile.name : (opts.typeToConfirm || '') });
}

export async function copyText(text, label = 'Skopiowano do schowka') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(label); } catch { toast('Nie udało się skopiować', 'error'); }
    ta.remove();
  }
}

export function download(url) {
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// busy wraps an async action, marking obj[flag] while running and reporting errors.
export async function busy(obj, flag, fn) {
  if (obj[flag]) return;
  obj[flag] = true; update();
  try { return await fn(); }
  catch (e) { toastErr(e); }
  finally { obj[flag] = false; update(); }
}

export function memberName(id) {
  const m = S.cluster && S.cluster.members.find((x) => x.id === id);
  return m ? (m.name || id) : id;
}
