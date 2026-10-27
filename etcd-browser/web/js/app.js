// Application shell: top bar with quorum and revision ruler, navigation, polling, boot.
import { h, S, mount, update, api, icon, toastErr, ask, fmtNum, pl, hooks } from './core.js';
import { ConnectView, loadProfiles, envLabel, LOGO } from './connect.js';
import { KeysView, resetKeys, keysNeedTick, keysShortcut, K } from './keys.js';
import { ClusterView, MaintView, loadCluster, health, needsClusterPoll } from './cluster.js';
import { LeasesView, AuthView, WatchView, leasesNeedTick, resetLeases, resetAuth, resetWatch, loadLeases, loadAuth } from './misc.js';

const NAV = [
  ['keys', 'keys', 'Klucze'],
  ['cluster', 'cluster', 'Klaster'],
  ['maint', 'maint', 'Konserwacja'],
  ['leases', 'lease', 'Dzierżawy'],
  ['auth', 'auth', 'Dostęp'],
  ['watch', 'watch', 'Obserwacja'],
];

function go(view) {
  if (view === S.view) {
    if (view === 'leases') loadLeases();
    if (view === 'auth') loadAuth();
    return;
  }
  S.view = view;
  if (view === 'cluster' || view === 'maint') loadCluster(true);
  update();
}

function quorum(c) {
  if (!c) return h('div', { class: 'quorum' }, h('span', { class: 'spinner' }));
  const hh = health(c);
  return h('button', { class: 'quorum', title: 'Członkowie klastra – kliknij, aby zobaczyć szczegóły', onClick: () => go('cluster') },
    c.members.map((m) => h('span', {
      key: m.id,
      class: 'qdot' + (!m.status ? ' down' : '') + (m.isLearner ? ' learner' : '') + (m.isLeader ? ' leader' : ''),
      title: `${m.name || m.id}: ${m.isLeader ? 'lider' : m.isLearner ? 'learner' : m.status ? 'follower' : 'niedostępny'}`,
    })),
    h('span', { class: 'quorum-label' }, hh.quorum ? `${hh.up}/${hh.total}` : 'brak kworum'));
}

// The revision ruler: hatched = history removed by compaction, solid = history still kept.
function ruler(c) {
  if (!c || !c.revision) return null;
  const cur = c.revision, comp = c.compactRevision || 0;
  const kept = cur - comp;
  const keptPct = Math.max(2, Math.min(100, (kept / cur) * 100));
  return h('button', { class: 'ruler', onClick: () => go('maint'),
    title: `Bieżąca rewizja: ${fmtNum(cur)}\n${comp ? `Skompaktowano do rewizji ${fmtNum(comp)}` : 'Historia nigdy nie była kompaktowana'}\nHistoria w bazie: ${pl(kept, 'rewizja', 'rewizje', 'rewizji')}` },
    h('span', { class: 'ruler-rev num' }, fmtNum(cur), h('small', null, 'rewizja')),
    h('span', { class: 'ruler-track' }, h('i', { class: 'ruler-gone', style: `flex:${100 - keptPct}` }), h('i', { class: 'ruler-kept', style: `flex:${keptPct}` })),
    h('span', { class: 'ruler-cap' },
      h('span', null, comp ? `skompaktowano do ${fmtNum(comp)}` : 'bez kompakcji'),
      h('span', null, `historia: ${fmtNum(kept)}`)));
}

function topbar() {
  const p = S.profile;
  const c = S.cluster;
  const theme = S.settings.theme || 'auto';
  const nextTheme = { auto: 'dark', dark: 'light', light: 'auto' }[theme];
  return h('header', { class: 'topbar' + (p.env ? ' env-' + p.env : '') },
    h('div', { class: 'brand' }, h('svg', { viewBox: '0 0 40 40', html: LOGO })),
    h('div', { class: 'conn' },
      h('span', { class: 'conn-name ellipsis' }, p.name),
      p.env && h('span', { class: 'badge env-' + p.env }, envLabel(p.env)),
      p.readOnly && h('span', { class: 'badge', title: 'Zmiany są zablokowane w tym profilu' }, icon('lock'), ' tylko odczyt'),
      h('span', { class: 'conn-eps ellipsis', title: p.endpoints.join('\n') }, p.endpoints.join(', '))),
    quorum(c),
    ruler(c),
    h('span', { class: 'grow' }),
    S.clusterErr && h('span', { class: 'err-text ellipsis', style: 'max-width:300px', title: S.clusterErr }, S.clusterErr),
    h('button', { class: 'btn ghost icon', title: `Motyw: ${{ auto: 'systemowy', dark: 'ciemny', light: 'jasny' }[theme]}`, onClick: () => setTheme(nextTheme) }, icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'sun')),
    h('button', { class: 'btn ghost', title: 'Rozłącz i wróć do listy połączeń', onClick: disconnect }, icon('power'), 'Rozłącz'));
}

function setTheme(t) {
  S.settings.theme = t;
  applyTheme();
  api('/api/settings', { theme: t }).catch(() => {});
  update();
}

function applyTheme() {
  const t = S.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

async function disconnect() {
  if (K.editing) {
    const ok = await ask({ title: 'Rozłączyć?', message: 'Edytowana wartość nie została zapisana.', confirm: 'Rozłącz', danger: true });
    if (!ok) return;
  }
  try { await api('/api/disconnect', {}); } catch (e) { toastErr(e); }
  S.connected = false; S.profile = null; S.cluster = null; S.clusterErr = '';
  document.title = 'etcd browser';
  resetAll();
  loadProfiles().catch(toastErr);
  update();
}

hooks.disconnect = disconnect;

function resetAll() { resetKeys(); resetLeases(); resetAuth(); resetWatch(); }

function nav() {
  const c = S.cluster;
  const alarms = c ? c.alarms.length : 0;
  return h('nav', { class: 'nav' }, NAV.map(([id, ic, label]) =>
    h('button', { key: id, class: S.view === id ? 'on' : '', onClick: () => go(id), title: label },
      icon(ic), label,
      id === 'maint' && alarms > 0 && h('span', { class: 'count' }, alarms))));
}

function modalView() {
  const m = S.modal;
  if (!m) return null;
  const v = m.render(m);
  return h('div', { class: 'overlay', onMousedown: (e) => { if (e.target === e.currentTarget) m.close(); } },
    h('div', { class: 'modal' + (v.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-h' }, v.title),
      h('div', { class: 'modal-b' }, v.body),
      v.actions && h('div', { class: 'modal-f' }, v.actions)));
}

function toastsView() {
  return h('div', { class: 'toasts', 'aria-live': 'polite' }, S.toasts.map((t) =>
    h('div', { key: t.id, class: 'toast ' + t.kind }, h('span', null, t.msg),
      h('button', { onClick: () => { S.toasts = S.toasts.filter((x) => x.id !== t.id); update(); }, 'aria-label': 'Zamknij' }, icon('x')))));
}

function App() {
  if (S.dead) return h('div', { class: 'dead' }, h('div', null, h('h2', null, 'Aplikacja nie działa'), h('p', { class: 'muted' }, S.dead)));
  if (S.boot) return h('div', { class: 'dead' }, h('span', { class: 'spinner' }));
  let body;
  if (!S.connected) body = ConnectView();
  else {
    let page;
    switch (S.view) {
      case 'cluster': page = ClusterView(); break;
      case 'maint': page = MaintView(); break;
      case 'leases': page = LeasesView(); break;
      case 'auth': page = AuthView(); break;
      case 'watch': page = WatchView(); break;
      default: page = KeysView();
    }
    body = h('div', { class: 'shell' }, topbar(), nav(), h('main', { class: 'main' }, page));
  }
  return h('div', { id: 'root', style: 'height:100%' }, body, modalView(), toastsView());
}

// ---------- boot ----------

function heartbeat() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(S.token));
  let failures = 0;
  es.addEventListener('hello', () => { failures = 0; if (S.dead) { S.dead = ''; update(); } });
  es.addEventListener('bye', () => { es.close(); S.dead = 'Aplikacja została zamknięta. Możesz zamknąć to okno.'; update(); });
  es.onerror = () => {
    failures++;
    if (failures > 3) { S.dead = 'Utracono kontakt z procesem etcd-browser. Uruchom aplikację ponownie.'; update(); }
  };
}

async function boot() {
  const u = new URL(location.href);
  const t = u.searchParams.get('token');
  if (t) { sessionStorage.setItem('etcd-browser-token', t); history.replaceState(null, '', '/'); }
  S.token = t || sessionStorage.getItem('etcd-browser-token') || '';
  if (!S.token) { S.dead = 'Brak klucza sesji. Otwórz aplikację ponownie z jej skrótu.'; S.boot = false; update(); return; }
  try {
    const [st, settings] = await Promise.all([api('/api/state'), api('/api/settings')]);
    S.settings = settings || {};
    applyTheme();
    resetAll();
    if (st.connected) { S.connected = true; S.profile = st.profile; document.title = `${st.profile.name} – etcd browser`; }
    await loadProfiles();
  } catch (e) {
    S.dead = e.message;
  }
  S.boot = false;
  update();
  heartbeat();
}

// cluster status polling: every 5 s on cluster pages, every 15 s elsewhere
let lastPoll = 0;
setInterval(() => {
  if (!S.connected || S.dead || document.hidden) return;
  const every = needsClusterPoll() ? 5000 : 15000;
  if (Date.now() - lastPoll >= every || !S.cluster) { lastPoll = Date.now(); loadCluster(true); }
  if (keysNeedTick() || leasesNeedTick()) update();
}, 1000);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.modal) { S.modal.close(); return; }
  if (S.modal || !S.connected) return;
  if (S.view === 'keys' && keysShortcut(e)) return;
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) { e.preventDefault(); loadCluster(); }
});

window.addEventListener('beforeunload', (e) => { if (K.editing) { e.preventDefault(); e.returnValue = ''; } });

mount(document.getElementById('app'), App);
boot();
