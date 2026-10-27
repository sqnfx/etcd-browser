// Keys view: lazy directory tree, search, value viewer/editor, history, import/export.
import {
  h, S, update, api, q, icon, toast, toastErr, ask, confirmDanger, openModal, busy, copyText, download, fileURL,
  b64ToBytes, bytesToB64, bytesToText, strToB64, b64ToText, hexdump, highlightJSON, esc, fmtNum, fmtSize, fmtDur, pl, readFileText, isProd,
} from './core.js';
import { watchPrefix } from './misc.js';

const ROW = 26;

export const K = {
  delim: '/',
  nodes: new Map(),
  sel: null, // {dir:bool, k, s}
  scroll: 0, height: 500, treeW: 380,
  search: { q: '', values: false, regex: false, ci: true, results: null, next: '', scanned: 0, loading: false },
  kv: null, kvAt: 0, kvErr: '', kvMissing: false, kvLoading: false,
  tab: 'value', mode: 'auto', editing: false, editText: '', editAs: 'text', lease: 'keep', leaseId: '', saving: false,
  hist: null, histSel: 0, histLoading: false,
  dirCount: null, dirCountFor: null,
  focusIdx: -1,
};

export function resetKeys() {
  K.nodes = new Map();
  K.sel = null; K.kv = null; K.kvErr = ''; K.kvMissing = false; K.editing = false; K.hist = null; K.scroll = 0;
  K.search.results = null; K.search.q = ''; K.dirCountFor = null;
  if (S.settings.delim != null) K.delim = S.settings.delim;
  if (S.settings.treeW) K.treeW = S.settings.treeW;
}

// ---------- tree loading ----------

async function loadNode(pfx, more = false) {
  let n = K.nodes.get(pfx);
  if (!n) { n = { open: true }; K.nodes.set(pfx, n); }
  if (more) n.loadingMore = true; else n.loading = true;
  n.err = '';
  update();
  try {
    const r = await api('/api/kv/children?' + q({ p: pfx, d: K.delim, after: more ? n.next : undefined }));
    if (more) { n.dirs = n.dirs.concat(r.dirs); n.keys = n.keys.concat(r.keys); }
    else { n.dirs = r.dirs; n.keys = r.keys; }
    n.next = r.next;
  } catch (e) {
    n.err = e.message;
  } finally {
    n.loading = false; n.loadingMore = false;
    update();
  }
}

export function ensureTree() {
  if (!K.nodes.has('')) loadNode('');
}

export async function refreshTree() {
  const open = [...K.nodes.entries()].filter(([p, n]) => p === '' || n.open).map(([p]) => p);
  await Promise.all(open.map((p) => loadNode(p)));
  if (K.sel && !K.sel.dir && !K.editing) loadKV(K.sel.k, true);
  loadDirCount(K.sel ? K.sel.k : '');
}

function toggleDir(e) {
  const n = K.nodes.get(e.k);
  if (n && n.open) { n.open = false; update(); return; }
  if (n && n.dirs) { n.open = true; update(); return; }
  loadNode(e.k);
}

function flatRows() {
  const out = [];
  const walk = (pfx, depth) => {
    const n = K.nodes.get(pfx);
    if (!n || (!n.dirs && n.loading)) { out.push({ t: 'note', depth, text: 'Wczytywanie…' }); return; }
    if (n.err) { out.push({ t: 'note', depth, text: n.err, err: true }); return; }
    if (!n.dirs) return;
    for (const d of n.dirs) {
      const c = K.nodes.get(d.k);
      const open = !!(c && c.open);
      out.push({ t: 'dir', depth, e: d, open, loading: c && c.loading });
      if (open) walk(d.k, depth + 1);
    }
    for (const k of n.keys) out.push({ t: 'key', depth, e: k });
    if (n.next) out.push({ t: 'more', depth, pfx, loading: n.loadingMore });
    if (depth === 0 && !n.dirs.length && !n.keys.length) out.push({ t: 'note', depth, text: 'Brak kluczy.' });
  };
  walk('', 0);
  return out;
}

function searchRows() {
  const s = K.search;
  return s.results.map((e) => ({ t: 'key', depth: 0, e: { ...e, name: e.s } }));
}

// ---------- selection & key loading ----------

export function openKey(k, s) {
  S.view = 'keys';
  selectKey({ k, s, dir: false });
  revealKey(k);
}

// revealKey expands every directory on the path to the key and scrolls it into view.
async function revealKey(k) {
  if (!K.delim) return;
  const bytes = b64ToBytes(k);
  const d = new TextEncoder().encode(K.delim);
  const prefixes = [];
  for (let i = 0; i + d.length <= bytes.length; i++) {
    if (d.every((x, j) => bytes[i + j] === x)) prefixes.push(bytesToB64(bytes.subarray(0, i + d.length)));
  }
  if (!K.nodes.get('')) await loadNode('');
  for (const p of prefixes) {
    const n = K.nodes.get(p);
    if (n && n.dirs) { n.open = true; continue; }
    await loadNode(p);
  }
  update();
  requestAnimationFrame(() => {
    const idx = flatRows().findIndex((r) => r.e && r.e.k === k);
    if (idx >= 0 && treeEl) {
      const top = idx * ROW;
      if (top < treeEl.scrollTop || top > treeEl.scrollTop + treeEl.clientHeight - ROW) treeEl.scrollTop = Math.max(0, top - treeEl.clientHeight / 3);
    }
  });
}

function selectKey(e) {
  if (K.editing && K.sel && K.sel.k !== e.k) {
    ask({ title: 'Porzucić zmiany?', message: 'Wartość ma niezapisane zmiany.', confirm: 'Porzuć zmiany', danger: true })
      .then((ok) => { if (ok) { K.editing = false; selectKey(e); } });
    return;
  }
  K.sel = { k: e.k, s: e.s, dir: !!e.dir };
  K.tab = 'value'; K.hist = null; K.editing = false; K.mode = 'auto';
  if (e.dir) { K.dirCountFor = e.k; K.dirCount = e.count != null ? e.count : null; loadDirCount(e.k); }
  else loadKV(e.k);
  update();
}

async function loadDirCount(k) {
  try { const r = await api('/api/kv/count?' + q({ p: k })); if (K.dirCountFor === k) { K.dirCount = r.count; update(); } }
  catch { /* ignore */ }
}

async function loadKV(k, quiet) {
  if (!quiet) { K.kvLoading = true; K.kv = null; }
  K.kvErr = ''; K.kvMissing = false;
  update();
  try {
    const r = await api('/api/kv/get?' + q({ k }));
    if (!K.sel || K.sel.k !== k) return;
    if (r.missing) { K.kvMissing = true; K.kv = null; }
    else { K.kv = r.kv; K.kvAt = Date.now(); }
  } catch (e) { K.kvErr = e.message; }
  finally { K.kvLoading = false; update(); }
}

// ---------- value helpers ----------

function valueInfo(kv) {
  const bytes = b64ToBytes(kv.v);
  const text = bytesToText(bytes);
  let json = null;
  if (text != null && /^\s*[[{"]/.test(text)) { try { json = JSON.parse(text); } catch { json = null; } }
  if (json === null && text != null && /^\s*(-?\d|true|false|null)/.test(text) && text.trim().length < 64) json = null;
  return { bytes, text, json };
}

function autoMode(info) {
  if (info.json !== null && typeof info.json === 'object') return 'json';
  if (info.text != null) return 'text';
  return 'hex';
}

function renderValue(kv) {
  const info = valueInfo(kv);
  const mode = K.mode === 'auto' ? autoMode(info) : K.mode;
  if (kv.size === 0) return h('div', { class: 'empty' }, h('b', null, 'Pusta wartość'), 'Klucz istnieje, ale nie ma zawartości.');
  if (mode === 'json' && info.json !== null) return h('pre', { class: 'val', html: highlightJSON(JSON.stringify(info.json, null, 2)) });
  if (mode === 'text' && info.text != null) return h('pre', { class: 'val' }, info.text);
  if (mode === 'b64') return h('pre', { class: 'val' }, kv.v);
  return h('pre', { class: 'hex', html: hexdump(info.bytes) });
}

function modeSeg(kv) {
  const info = valueInfo(kv);
  const cur = K.mode === 'auto' ? autoMode(info) : K.mode;
  const opts = [['text', 'Tekst', info.text != null], ['json', 'JSON', info.json !== null], ['hex', 'Hex', true], ['b64', 'Base64', true]];
  return h('div', { class: 'seg sm' }, opts.map(([m, l, ok]) => h('button', { class: cur === m ? 'on' : '', disabled: !ok, onClick: () => { K.mode = m; update(); } }, l)));
}

// ---------- editing ----------

function startEdit() {
  const info = valueInfo(K.kv);
  if (info.text != null) {
    K.editAs = 'text';
    K.editText = info.text;
  } else { K.editAs = 'b64'; K.editText = K.kv.v; }
  K.lease = K.kv.lease ? 'keep' : '';
  K.leaseId = '';
  K.editing = true;
  update();
}

function editedB64() {
  if (K.editAs === 'b64') {
    const clean = K.editText.replace(/\s+/g, '');
    try { atob(clean); } catch { throw new Error('Niepoprawny Base64'); }
    return clean;
  }
  return strToB64(K.editText);
}

function leaseValue() {
  if (K.lease === 'other') return K.leaseId.trim();
  return K.lease;
}

async function saveEdit(force) {
  const kv = K.kv;
  const v = editedB64();
  const r = await api('/api/kv/put', { k: kv.k, v, lease: leaseValue(), expect: force ? null : kv.mod });
  if (r.conflict) {
    const cur = r.current;
    const ok = await ask({
      title: 'Klucz został zmieniony',
      message: cur ? `Ktoś zmienił ten klucz od czasu otwarcia (rewizja ${fmtNum(kv.mod)} → ${fmtNum(cur.mod)}). Nadpisać jego zmiany Twoją wersją?` : 'Klucz został w międzyczasie usunięty. Utworzyć go ponownie z Twoją wartością?',
      confirm: 'Nadpisz', danger: true,
    });
    if (ok) return saveEdit(true);
    return;
  }
  K.editing = false;
  toast('Zapisano');
  await loadKV(kv.k, true);
  refreshParent(kv.k);
}

function refreshParent(k) {
  const s = b64ToBytes(k);
  // reload every open node that is a prefix of this key
  for (const [p, n] of K.nodes) {
    const pb = b64ToBytes(p);
    if ((p === '' || n.open) && pb.length <= s.length && pb.every((b, i) => s[i] === b)) loadNode(p);
  }
}

function formatJSON() {
  try { K.editText = JSON.stringify(JSON.parse(K.editText), null, 2); update(); }
  catch (e) { toast('To nie jest poprawny JSON: ' + e.message, 'error'); }
}

async function deleteKey() {
  const kv = K.kv;
  const ok = await confirmDanger({ title: 'Usunąć klucz?', message: h('p', null, 'Klucz ', h('b', { class: 'mono' }, kv.s), ' zostanie usunięty. Poprzednie wersje pozostaną dostępne w historii do najbliższej kompakcji.'), confirm: 'Usuń klucz' });
  if (!ok) return;
  const r = await api('/api/kv/delete', { k: kv.k, expect: kv.mod });
  if (r.conflict) { toast('Klucz zmienił się w międzyczasie – odśwież i spróbuj ponownie', 'error'); return; }
  toast('Usunięto klucz');
  K.sel = null; K.kv = null;
  refreshParent(kv.k);
}

async function deletePrefix(sel) {
  const r = await api('/api/kv/count?' + q({ p: sel.k }));
  if (!r.count) { toast('Pod tym prefiksem nie ma kluczy'); return; }
  const ok = await confirmDanger({
    title: `Usunąć ${pl(r.count, 'klucz', 'klucze', 'kluczy')}?`,
    message: h('p', null, 'Wszystkie klucze zaczynające się od ', h('b', { class: 'mono' }, sel.s || '(cały klaster)'), ` zostaną usunięte w jednej operacji (${pl(r.count, 'klucz', 'klucze', 'kluczy')}).`),
    confirm: 'Usuń wszystkie', typeToConfirm: isProd() ? '' : String(r.count),
  });
  if (!ok) return;
  const d = await api('/api/kv/delete', { k: sel.k, prefix: true, all: sel.k === '' });
  toast(`Usunięto ${pl(d.deleted, 'klucz', 'klucze', 'kluczy')}`);
  K.sel = null;
  refreshTree();
}

// ---------- modals ----------

export function newKeyModal(prefix = '') {
  return openModal((m) => ({
    title: 'Nowy klucz',
    wide: true,
    body: [
      h('label', { class: 'field' }, h('span', null, 'Klucz'),
        h('input', { class: 'input mono', value: m.key, mount: (el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, onInput: (e) => { m.key = e.target.value; update(); } })),
      h('label', { class: 'field' }, h('span', null, 'Wartość'),
        h('textarea', { class: 'input', rows: 10, spellcheck: 'false', value: m.value, onInput: (e) => { m.value = e.target.value; update(); } }),
        jsonHint(m.value)),
      h('label', { class: 'field' }, h('span', null, 'Dzierżawa (opcjonalnie)'),
        h('input', { class: 'input mono', placeholder: 'identyfikator szesnastkowy, np. 694d7a3b6f8e9c12', value: m.lease, onInput: (e) => { m.lease = e.target.value; update(); } }),
        h('small', null, 'Klucz z dzierżawą zniknie, gdy dzierżawa wygaśnie.')),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !m.key || m.busy, onClick: () => busy(m, 'busy', async () => {
        const k = strToB64(m.key);
        const r = await api('/api/kv/put', { k, v: strToB64(m.value), lease: m.lease.trim(), expect: 0 });
        if (r.conflict) { toast('Taki klucz już istnieje', 'error'); return; }
        toast('Utworzono klucz');
        m.close();
        refreshParent(k);
        openKey(k, m.key);
      }) }, 'Utwórz klucz'),
    ],
  }), { key: prefix, value: '', lease: '' });
}

function jsonHint(text) {
  const t = text.trim();
  if (!t || !/^[[{]/.test(t)) return null;
  try { JSON.parse(t); return h('small', { style: 'color:var(--ok)' }, 'Poprawny JSON'); }
  catch (e) { return h('small', { style: 'color:var(--warn)' }, 'Wygląda na JSON, ale zawiera błąd: ' + e.message); }
}

function saveAsModal() {
  const kv = K.kv;
  return openModal((m) => ({
    title: 'Zapisz jako nowy klucz',
    body: [
      h('p', { class: 'muted' }, 'Wartość zostanie skopiowana do nowego klucza. Oryginał pozostaje bez zmian.'),
      h('label', { class: 'field' }, h('span', null, 'Nowy klucz'),
        h('input', { class: 'input mono', value: m.key, mount: (el) => el.focus(), onInput: (e) => { m.key = e.target.value; update(); } })),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !m.key || m.key === kv.s || m.busy, onClick: () => busy(m, 'busy', async () => {
        const k = strToB64(m.key);
        const v = K.editing ? editedB64() : kv.v;
        const r = await api('/api/kv/put', { k, v, lease: '', expect: 0 });
        if (r.conflict) { toast('Taki klucz już istnieje', 'error'); return; }
        toast('Zapisano kopię');
        m.close();
        K.editing = false;
        refreshParent(k);
        openKey(k, m.key);
      }) }, 'Zapisz kopię'),
    ],
  }), { key: kv.bin ? '' : kv.s + '-kopia' });
}

export function importModal(targetPrefix = '') {
  let fileInput;
  return openModal((m) => ({
    title: 'Import kluczy',
    wide: true,
    body: [
      h('p', { class: 'muted' }, 'Obsługiwane pliki: eksport z etcd browser, wynik ', h('span', { class: 'mono' }, 'etcdctl get --prefix -w json'), ' oraz prosty obiekt JSON klucz → wartość.'),
      h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', ref: (el) => (fileInput = el), onChange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const text = await readFileText(f);
          const data = JSON.parse(text);
          m.data = data; m.fileName = f.name; m.check = null;
          m.count = Array.isArray(data.items) ? data.items.length : Array.isArray(data.kvs) ? data.kvs.length : Object.keys(data).length;
          if (typeof data.prefix === 'string') { m.from = data.prefix; m.to = targetPrefix || data.prefix; }
          update();
        } catch (err) { toast('Nie udało się odczytać pliku: ' + err.message, 'error'); }
        e.target.value = '';
      } }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => fileInput.click() }, icon('upload'), m.fileName ? 'Zmień plik' : 'Wybierz plik JSON'),
        m.fileName && h('span', null, h('b', null, m.fileName), ' – ', pl(m.count, 'element', 'elementy', 'elementów'))),
      m.data && [
        h('div', { class: 'cols2' },
          h('label', { class: 'field' }, h('span', null, 'Zamień prefiks z'), h('input', { class: 'input mono', placeholder: '(bez zmiany)', value: m.from, onInput: (e) => { m.from = e.target.value; m.check = null; update(); } })),
          h('label', { class: 'field' }, h('span', null, 'na'), h('input', { class: 'input mono', placeholder: '(bez zmiany)', value: m.to, onInput: (e) => { m.to = e.target.value; m.check = null; update(); } }))),
        h('div', { class: 'field' }, h('span', null, 'Istniejące klucze'),
          h('div', { class: 'seg' },
            h('button', { class: m.mode === 'skip' ? 'on' : '', onClick: () => { m.mode = 'skip'; m.check = null; update(); } }, 'Pomiń'),
            h('button', { class: m.mode === 'overwrite' ? 'on' : '', onClick: () => { m.mode = 'overwrite'; m.check = null; update(); } }, 'Nadpisz'))),
        m.check && h('div', { class: 'banner info' }, icon('check'), h('div', null,
          h('div', null, `Do zapisania: ${pl(m.check.written, 'klucz', 'klucze', 'kluczy')}. Już istnieje: ${fmtNum(m.check.existing)}${m.mode === 'skip' ? ' (zostaną pominięte)' : ' (zostaną nadpisane)'}.`,
            m.check.outside ? ` Poza prefiksem źródłowym (pominięte): ${fmtNum(m.check.outside)}.` : ''),
          m.check.sample.length > 0 && h('div', { class: 'mono muted', style: 'margin-top:6px' }, m.check.sample.slice(0, 5).join('\n'), m.check.written > 5 ? '\n…' : ''))),
      ],
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn', disabled: !m.data || m.busy, onClick: () => busy(m, 'busy', async () => {
        m.check = await api('/api/kv/import', { data: m.data, mode: m.mode, from: m.from, to: m.to, dryRun: true });
      }) }, 'Sprawdź'),
      h('button', { class: 'btn primary', disabled: !m.data || m.busy || !m.check, title: m.check ? '' : 'Najpierw sprawdź import', onClick: async () => {
        if (m.mode === 'overwrite' && m.check.existing > 0) {
          const ok = await confirmDanger({ title: 'Nadpisać istniejące klucze?', message: `${pl(m.check.existing, 'klucz zostanie nadpisany', 'klucze zostaną nadpisane', 'kluczy zostanie nadpisanych')}.`, confirm: 'Importuj i nadpisz' });
          if (!ok) return;
        }
        busy(m, 'busy', async () => {
          const r = await api('/api/kv/import', { data: m.data, mode: m.mode, from: m.from, to: m.to });
          toast(`Zaimportowano ${pl(r.written, 'klucz', 'klucze', 'kluczy')}${r.skipped ? `, pominięto ${fmtNum(r.skipped)}` : ''}`);
          m.close();
          refreshTree();
        });
      } }, 'Importuj'),
    ],
  }), { mode: 'skip', from: '', to: targetPrefix });
}

// ---------- history ----------

async function loadHistory() {
  K.histLoading = true; update();
  try { K.hist = await api('/api/kv/history?' + q({ k: K.kv.k, limit: 50 })); K.histSel = Math.min(1, K.hist.versions.length - 1); }
  catch (e) { toastErr(e); }
  finally { K.histLoading = false; update(); }
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e);
  const n = a2.length, m = b2.length;
  if (n * m > 4e6) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mid = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { mid.push([' ', a2[i]]); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { mid.push(['-', a2[i]]); i++; }
    else { mid.push(['+', b2[j]]); j++; }
  }
  const all = [...A.slice(0, s).map((l) => [' ', l]), ...mid, ...A.slice(A.length - e).map((l) => [' ', l])];
  // collapse long unchanged runs
  const out = [];
  let run = [];
  const flush = (last) => {
    if (run.length > 8) {
      if (out.length) out.push(...run.slice(0, 3));
      out.push(['…', `${run.length - (out.length ? 3 : 0) - (last ? 0 : 3)} niezmienionych wierszy`]);
      if (!last) out.push(...run.slice(-3));
    } else out.push(...run);
    run = [];
  };
  for (const d of all) { if (d[0] === ' ') run.push(d); else { flush(false); out.push(d); } }
  flush(true);
  return out;
}

function historyView() {
  if (K.histLoading && !K.hist) return h('div', { class: 'empty' }, h('span', { class: 'spinner' }));
  if (!K.hist) return null;
  const vs = K.hist.versions;
  const endText = { created: 'Początek – utworzenie klucza.', compacted: 'Starsze wersje usunęła kompakcja.', limit: 'Pokazano 50 najnowszych wersji.', deleted: 'Wcześniej klucz był usunięty.' }[K.hist.end];
  const sel = vs[K.histSel];
  const cur = vs[0];
  let detail = null;
  if (sel) {
    const oldT = b64ToText(sel.v), curT = b64ToText(cur.v);
    const isCur = K.histSel === 0;
    let body;
    if (isCur) body = renderValue(sel);
    else if (oldT != null && curT != null) {
      const pretty = (t) => { try { const j = JSON.parse(t); return typeof j === 'object' && j ? JSON.stringify(j, null, 2) : t; } catch { return t; } };
      const d = lineDiff(pretty(oldT), pretty(curT));
      body = d ? h('div', { class: 'diff' }, d.map(([t, l]) => h('div', { class: t === '+' ? 'add' : t === '-' ? 'del' : '', style: t === '…' ? 'color:var(--muted);font-style:italic' : '' }, l || ' ')))
        : renderValue(sel);
    } else body = renderValue(sel);
    detail = h('div', { class: 'stack' },
      h('div', { class: 'row wrap' },
        h('b', null, isCur ? 'Bieżąca wersja' : `Wersja ${sel.ver} → bieżąca`),
        !isCur && h('span', { class: 'muted' }, 'czerwone wiersze były w tej wersji, zielone są teraz'),
        h('span', { class: 'grow' }),
        !isCur && !S.profile.readOnly && h('button', { class: 'btn sm', onClick: () => restoreVersion(sel).catch(toastErr) }, icon('history'), 'Przywróć tę wersję')),
      h('div', { class: 'valbox' }, body));
  }
  return h('div', { class: 'hist' },
    h('div', { class: 'hist-list' },
      vs.map((v, i) => h('div', { key: v.mod, class: 'hist-item' + (i === K.histSel ? ' sel' : ''), onClick: () => { K.histSel = i; update(); } },
        h('div', { class: 'row' }, h('b', null, `Wersja ${v.ver}`), i === 0 && h('span', { class: 'badge accent' }, 'bieżąca')),
        h('div', { class: 'mono' }, `rev ${fmtNum(v.mod)}  ${fmtSize(v.size)}`))),
      h('div', { class: 'hist-item muted', style: 'cursor:default;font-size:12px' }, endText)),
    detail);
}

async function restoreVersion(v) {
  const ok = await ask({ title: 'Przywrócić wersję?', message: `Wartość z wersji ${v.ver} (rewizja ${fmtNum(v.mod)}) zostanie zapisana jako nowa wersja klucza.`, confirm: 'Przywróć' });
  if (!ok) return;
  if (v.size > 256 * 1024) {
    const full = await api('/api/kv/get?' + q({ k: K.kv.k, rev: v.mod }));
    v = full.kv;
  }
  const r = await api('/api/kv/put', { k: K.kv.k, v: v.v, lease: 'keep', expect: K.kv.mod });
  if (r.conflict) { toast('Klucz zmienił się w międzyczasie – odśwież historię', 'error'); return; }
  toast('Przywrócono wersję');
  await loadKV(K.kv.k, true);
  K.hist = null; loadHistory();
}

// ---------- search ----------

async function runSearch(more) {
  const s = K.search;
  if (!s.q.trim()) { s.results = null; update(); return; }
  s.loading = true; update();
  try {
    const r = await api('/api/kv/search?' + q({ p: '', q: s.q, values: s.values ? 1 : 0, regex: s.regex ? 1 : 0, ci: s.ci ? 1 : 0, after: more ? s.next : undefined }));
    s.results = more ? s.results.concat(r.matches) : r.matches;
    s.next = r.next; s.scanned = (more ? s.scanned : 0) + r.scanned;
    K.scroll = more ? K.scroll : 0;
  } catch (e) { toastErr(e); }
  finally { s.loading = false; update(); }
}

// ---------- rendering ----------

function treeRow(r, i) {
  const style = `top:${i * ROW}px;padding-left:${10 + r.depth * 16}px`;
  if (r.t === 'note') return h('div', { key: 'n' + i, class: 'trow note', style }, r.err ? h('span', { class: 'err-text' }, r.text) : r.text);
  if (r.t === 'more') return h('div', { key: 'm' + r.pfx, class: 'trow more', style, onClick: () => loadNode(r.pfx, true) }, r.loading ? h('span', { class: 'spinner' }) : icon('plus'), 'Wczytaj więcej…');
  const e = r.e;
  const sel = K.sel && K.sel.k === e.k;
  if (r.t === 'dir') {
    return h('div', { key: 'd' + e.k, class: 'trow dir' + (r.open ? ' open' : '') + (sel ? ' sel' : ''), style, title: e.s,
      onClick: () => { toggleDir(e); selectKey(e); } },
      h('span', { class: 'tw' }, r.loading ? h('span', { class: 'spinner', style: 'width:10px;height:10px' }) : icon('chevron')),
      h('span', { class: 'tname' }, e.name || e.s),
      e.count != null && h('span', { class: 'tcount' }, fmtNum(e.count)));
  }
  return h('div', { key: 'k' + e.k, class: 'trow key' + (sel ? ' sel' : ''), style, title: e.s, onClick: () => selectKey(e) },
    h('span', { class: 'tw' }),
    h('span', { class: 'tname' }, e.name === '' ? '(pusta nazwa)' : e.name),
    e.lease && h('span', { class: 'tlease', title: 'Klucz z dzierżawą ' + e.lease }, icon('lease')));
}

function onTreeKey(e, rows) {
  const idx = rows.findIndex((r) => r.e && K.sel && r.e.k === K.sel.k);
  const go = (i) => {
    const r = rows[i];
    if (!r || !r.e) return;
    selectKey(r.e);
    const top = i * ROW;
    const el = e.currentTarget;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); let i = idx + 1; while (rows[i] && !rows[i].e) i++; go(i); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); let i = idx - 1; while (i >= 0 && !rows[i].e) i--; go(Math.max(i, 0)); }
  else if (e.key === 'ArrowRight' && idx >= 0 && rows[idx].t === 'dir' && !rows[idx].open) { e.preventDefault(); toggleDir(rows[idx].e); }
  else if (e.key === 'ArrowLeft' && idx >= 0 && rows[idx].t === 'dir' && rows[idx].open) { e.preventDefault(); toggleDir(rows[idx].e); }
}

let treeEl = null, resizeObs = null;
function treeRef(el) {
  if (treeEl === el) return;
  treeEl = el;
  if (resizeObs) resizeObs.disconnect();
  resizeObs = new ResizeObserver(() => { if (Math.abs(K.height - el.clientHeight) > 2) { K.height = el.clientHeight; update(); } });
  resizeObs.observe(el);
  K.height = el.clientHeight || 500;
}

function startResize(e) {
  e.preventDefault();
  const startX = e.clientX, startW = K.treeW;
  const move = (ev) => { K.treeW = Math.max(220, Math.min(window.innerWidth - 420, startW + ev.clientX - startX)); update(); };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    api('/api/settings', { treeW: K.treeW }).catch(() => {});
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function chip(label, on, toggle, title) {
  return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), title, 'aria-pressed': on ? 'true' : 'false', onClick: () => { toggle(); update(); } }, label);
}

function leftPane() {
  const s = K.search;
  const searching = s.results != null;
  const rows = searching ? searchRows() : flatRows();
  const first = Math.max(0, Math.floor(K.scroll / ROW) - 8);
  const last = Math.min(rows.length, first + Math.ceil(K.height / ROW) + 16);
  const visible = [];
  for (let i = first; i < last; i++) visible.push(treeRow(rows[i], i));
  return h('div', { class: 'keys-left' },
    h('div', { class: 'keys-tools' },
      h('form', { class: 'searchbox', onSubmit: (e) => { e.preventDefault(); runSearch(false); } },
        icon('search'),
        h('input', { class: 'input', placeholder: s.values ? 'Szukaj w kluczach i wartościach…' : 'Szukaj w kluczach…', value: s.q,
          onInput: (e) => { s.q = e.target.value; if (!s.q) { s.results = null; K.scroll = 0; } update(); } })),
      h('div', { class: 'row', style: 'gap:4px' },
        chip('w wartościach', s.values, () => { s.values = !s.values; }, 'Szukaj także w wartościach (wolniejsze – przegląda do 100 000 kluczy na raz)'),
        chip('.*', s.regex, () => { s.regex = !s.regex; }, 'Wyrażenie regularne (składnia RE2)'),
        chip('Aa', !s.ci, () => { s.ci = !s.ci; }, 'Rozróżniaj wielkość liter'),
        h('span', { class: 'grow' }),
        h('select', { class: 'input', style: 'height:26px;padding:0 4px;font-size:12.5px', title: 'Separator poziomów drzewa', value: K.delim,
          onChange: (e) => { K.delim = e.target.value; api('/api/settings', { delim: K.delim }).catch(() => {}); K.nodes = new Map(); K.scroll = 0; loadNode(''); } },
          h('option', { value: '/' }, 'drzewo /'), h('option', { value: ':' }, 'drzewo :'), h('option', { value: '.' }, 'drzewo .'), h('option', { value: '' }, 'lista płaska')))),
    h('div', { class: 'tree', tabindex: 0, ref: treeRef, onScroll: (e) => { K.scroll = e.target.scrollTop; update(); }, onKeydown: (e) => onTreeKey(e, rows) },
      h('div', { style: `height:${rows.length * ROW}px;position:relative` }, visible)),
    h('div', { class: 'tree-foot' },
      searching
        ? [s.loading ? h('span', { class: 'spinner' }) : null,
          h('span', null, `${pl(s.results.length, 'wynik', 'wyniki', 'wyników')}, przeszukano ${fmtNum(s.scanned)}`),
          s.next && h('button', { class: 'btn sm ghost', onClick: () => runSearch(true) }, 'Szukaj dalej'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn sm ghost', onClick: () => { s.results = null; s.q = ''; K.scroll = 0; update(); } }, 'Wyczyść')]
        : [h('span', { class: 'grow' }, K.sel && K.sel.dir ? K.sel.s : ''),
          h('button', { class: 'btn sm ghost icon', title: 'Odśwież (F5)', onClick: () => refreshTree() }, icon('refresh'))]));
}

function ensureDirCount(k) {
  if (K.dirCountFor === k) return;
  K.dirCountFor = k; K.dirCount = null;
  loadDirCount(k);
}

function dirPanel(sel) {
  ensureDirCount(sel.k);
  const ro = S.profile.readOnly;
  const isRoot = sel.k === '';
  return h('div', { class: 'editor' },
    h('div', { class: 'ed-head', style: 'padding-bottom:14px' },
      h('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:2px' }, isRoot ? 'Cała przestrzeń kluczy' : 'Prefiks'),
      h('div', { class: 'ed-key' }, isRoot ? 'Wszystkie klucze' : sel.s),
      h('div', { class: 'ed-meta' }, h('span', null, 'Kluczy: ', h('b', null, K.dirCount == null ? '…' : fmtNum(K.dirCount))))),
    h('div', { class: 'page' },
      h('div', { class: 'grid2' },
        h('div', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', null, 'Dane')),
          h('div', { class: 'panel-b stack start' },
            !ro && h('button', { class: 'btn', onClick: () => newKeyModal(sel.s) }, icon('plus'), isRoot ? 'Nowy klucz' : 'Nowy klucz w tym prefiksie'),
            h('button', { class: 'btn', onClick: () => download(fileURL('/api/kv/export', { p: sel.k })) }, icon('download'), 'Eksportuj do JSON'),
            !ro && h('button', { class: 'btn', onClick: () => importModal(sel.s) }, icon('upload'), 'Importuj z pliku JSON'),
            h('button', { class: 'btn', onClick: () => watchPrefix(sel.s) }, icon('watch'), 'Obserwuj zmiany na żywo'))),
        !ro && h('div', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', null, 'Usuwanie')),
          h('div', { class: 'panel-b stack start' },
            h('p', { class: 'muted', style: 'margin:0' }, isRoot ? 'Usuwa wszystkie klucze w klastrze. Tej operacji nie można cofnąć poza przywróceniem ze snapshotu.' : 'Usuwa wszystkie klucze zaczynające się od tego prefiksu, w jednej transakcji.'),
            h('button', { class: 'btn danger', onClick: () => deletePrefix(sel).catch(toastErr) }, icon('trash'), isRoot ? 'Usuń wszystkie klucze' : 'Usuń klucze z prefiksem'))))));
}

function leaseMeta(kv) {
  if (!kv.lease) return null;
  const left = kv.leaseTTL != null ? kv.leaseTTL - (Date.now() - K.kvAt) / 1000 : null;
  return h('span', null, 'Dzierżawa: ', h('b', null, kv.lease), left != null && h('span', null, ` (wygasa za ${fmtDur(Math.max(0, left))})`));
}

function keyPanel() {
  if (K.kvLoading) return h('div', { class: 'editor' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  if (K.kvErr) return h('div', { class: 'editor' }, h('div', { class: 'empty' }, h('b', null, 'Nie udało się wczytać klucza'), K.kvErr));
  if (K.kvMissing) return h('div', { class: 'editor' }, h('div', { class: 'empty' }, h('b', null, 'Klucz już nie istnieje'), 'Został usunięty albo wygasła jego dzierżawa.',
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', onClick: () => refreshTree() }, icon('refresh'), 'Odśwież drzewo'))));
  const kv = K.kv;
  if (!kv) return h('div', { class: 'editor' });
  const ro = S.profile.readOnly;
  const ed = K.editing;
  return h('div', { class: 'editor' },
    h('div', { class: 'ed-head' },
      h('div', { class: 'row', style: 'align-items:flex-start' },
        h('div', { class: 'ed-key grow' }, kv.s),
        kv.bin && h('span', { class: 'badge', title: 'Klucz zawiera bajty spoza UTF-8 – pokazano je jako \\xNN' }, 'binarny'),
        h('button', { class: 'btn sm ghost icon', title: 'Kopiuj klucz', onClick: () => copyText(kv.s, 'Skopiowano klucz') }, icon('copy'))),
      h('div', { class: 'ed-meta' },
        h('span', null, 'Wersja ', h('b', null, fmtNum(kv.ver))),
        h('span', null, 'Utworzono w rev ', h('b', null, fmtNum(kv.create))),
        h('span', null, 'Zmieniono w rev ', h('b', null, fmtNum(kv.mod))),
        h('span', null, 'Rozmiar ', h('b', null, fmtSize(kv.size))),
        leaseMeta(kv)),
      h('div', { class: 'tabs' },
        h('button', { class: K.tab === 'value' ? 'on' : '', onClick: () => { K.tab = 'value'; update(); } }, 'Wartość'),
        h('button', { class: K.tab === 'hist' ? 'on' : '', onClick: () => { K.tab = 'hist'; if (!K.hist) loadHistory(); update(); } }, 'Historia'))),
    K.tab === 'value' ? [
      h('div', { class: 'ed-tools' },
        ed ? [
          h('button', { class: 'btn primary sm', disabled: K.saving, onClick: () => busy(K, 'saving', () => saveEdit(false)) }, K.saving ? h('span', { class: 'spinner' }) : icon('check'), 'Zapisz'),
          h('button', { class: 'btn sm', onClick: () => { K.editing = false; update(); } }, 'Anuluj'),
          K.editAs === 'text' && h('button', { class: 'btn sm ghost', onClick: formatJSON }, 'Formatuj JSON'),
          K.editAs === 'b64' && h('span', { class: 'badge' }, 'edycja jako Base64'),
          h('span', { class: 'grow' }),
          h('select', { class: 'input', style: 'height:26px;font-size:12.5px', value: K.lease, onChange: (e) => { K.lease = e.target.value; update(); } },
            kv.lease && h('option', { value: 'keep' }, `Zachowaj dzierżawę ${kv.lease}`),
            h('option', { value: '' }, 'Bez dzierżawy'),
            h('option', { value: 'other' }, 'Inna dzierżawa…')),
          K.lease === 'other' && h('input', { class: 'input mono', style: 'height:26px;width:170px', placeholder: 'id szesnastkowo', value: K.leaseId, onInput: (e) => { K.leaseId = e.target.value; } }),
        ] : [
          modeSeg(kv),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn sm ghost', onClick: () => { const t = b64ToText(kv.v); copyText(t != null ? t : kv.v, 'Skopiowano wartość'); } }, icon('copy'), 'Kopiuj'),
          !ro && h('button', { class: 'btn sm ghost', onClick: () => saveAsModal() }, 'Zapisz jako…'),
          !ro && h('button', { class: 'btn sm ghost danger', onClick: () => deleteKey().catch(toastErr) }, icon('trash'), 'Usuń'),
          !ro && h('button', { class: 'btn sm primary', onClick: startEdit }, icon('edit'), 'Edytuj'),
        ]),
      h('div', { class: 'ed-body' },
        ed ? h('textarea', { class: 'val-edit', spellcheck: 'false', value: K.editText, mount: (el) => el.focus(),
          onInput: (e) => { K.editText = e.target.value; },
          onKeydown: (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); busy(K, 'saving', () => saveEdit(false)); }
            if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); K.editText = t.value; }
            if (e.key === 'Escape') { K.editing = false; update(); }
          } })
          : h('div', { class: 'valbox' }, renderValue(kv))),
    ] : h('div', { class: 'ed-body', style: 'padding-top:14px' }, historyView()));
}

function welcome() {
  return dirPanel({ k: '', s: '', dir: true });
}

export function KeysView() {
  ensureTree();
  let right;
  if (!K.sel) right = welcome();
  else if (K.sel.dir) right = dirPanel(K.sel);
  else right = keyPanel();
  return h('div', { class: 'keys', style: `--tree-w:${K.treeW}px` },
    leftPane(),
    h('div', { class: 'splitter', onPointerdown: startResize }),
    right);
}

export function keysNeedTick() { return S.view === 'keys' && K.kv && K.kv.lease && !K.editing; }

export function keysShortcut(e) {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) { e.preventDefault(); refreshTree(); return true; }
  return false;
}
