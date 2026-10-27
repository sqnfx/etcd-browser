// Leases, users & roles, live watch.
import {
  h, S, update, api, q, icon, toast, toastErr, ask, confirmDanger, openModal, busy, fmtNum, fmtDur, fmtSize, pl,
  strToB64, b64ToText, b64ToBytes, hexdump, hooks,
} from './core.js';
import { openKey } from './keys.js';

// ---------- leases ----------

const L = { list: null, total: 0, at: 0, loading: false, err: '', open: {} };

export async function loadLeases() {
  L.loading = true; update();
  try { const r = await api('/api/leases'); L.list = r.leases; L.total = r.total; L.at = Date.now(); L.err = ''; }
  catch (e) { L.err = e.message; }
  finally { L.loading = false; update(); }
}

function grantModal() {
  return openModal((m) => ({
    title: 'Nowa dzierżawa',
    body: [
      h('p', { class: 'muted' }, 'Dzierżawa wygasa po czasie TTL, jeśli nikt jej nie odnowi. Klucze do niej przypisane zostaną wtedy usunięte.'),
      h('label', { class: 'field' }, h('span', null, 'TTL w sekundach'), h('input', { class: 'input mono', type: 'number', min: 1, value: m.ttl, mount: (el) => el.focus(), onInput: (e) => { m.ttl = e.target.value; update(); } })),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !(+m.ttl > 0) || m.busy, onClick: () => busy(m, 'busy', async () => {
        const r = await api('/api/leases/grant', { ttl: +m.ttl });
        toast(`Utworzono dzierżawę ${r.id} (TTL ${fmtDur(r.ttl)})`);
        m.close(); loadLeases();
      }) }, 'Utwórz dzierżawę'),
    ],
  }), { ttl: '60' });
}

async function revoke(l) {
  const ok = await confirmDanger({ title: `Unieważnić dzierżawę ${l.id}?`, message: l.nKeys ? `Razem z nią zostanie usuniętych ${pl(l.nKeys, 'klucz', 'klucze', 'kluczy')}.` : 'Do dzierżawy nie są przypisane żadne klucze.', confirm: 'Unieważnij' });
  if (!ok) return;
  await api('/api/leases/revoke', { id: l.id });
  toast(`Unieważniono dzierżawę ${l.id}`);
  loadLeases();
}

async function keepAlive(l) {
  const r = await api('/api/leases/keepalive', { id: l.id });
  toast(`Odnowiono dzierżawę ${l.id} – TTL ${fmtDur(r.ttl)}`);
  loadLeases();
}

export function LeasesView() {
  if (!L.list && !L.loading && !L.err) loadLeases();
  const ro = S.profile.readOnly;
  const elapsed = (Date.now() - L.at) / 1000;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Dzierżawy'), h('p', null, 'Klucze z ograniczonym czasem życia – rejestracje usług, blokady, wybory lidera.')),
      L.loading && h('span', { class: 'spinner' }),
      h('button', { class: 'btn', onClick: loadLeases }, icon('refresh'), 'Odśwież'),
      !ro && h('button', { class: 'btn primary', onClick: grantModal }, icon('plus'), 'Nowa dzierżawa')),
    L.err && h('div', { class: 'banner danger' }, icon('alert'), L.err),
    L.list && (L.list.length === 0 ? h('div', { class: 'panel empty' }, h('b', null, 'Brak aktywnych dzierżaw'), 'Utwórz dzierżawę, aby klucze same znikały po czasie.')
      : h('div', { class: 'panel' },
        L.total > L.list.length && h('div', { class: 'banner', style: 'margin:12px' }, `Pokazano szczegóły ${fmtNum(L.list.length)} z ${fmtNum(L.total)} dzierżaw.`),
        h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', null, 'Identyfikator'), h('th', null, 'Pozostało'), h('th', null, 'TTL nadany'), h('th', null, 'Klucze'), h('th', { class: 'r' }, ''))),
          h('tbody', null, L.list.map((l) => {
            const left = Math.max(0, l.ttl - elapsed);
            const pct = l.granted ? Math.min(100, (left / l.granted) * 100) : 0;
            const open = L.open[l.id];
            return [
              h('tr', { key: l.id },
                h('td', { class: 'mono' }, l.id),
                h('td', null, l.error ? h('span', { class: 'err-text' }, l.error) : [
                  h('div', { class: 'num' }, l.ttl < 0 ? 'wygasła' : fmtDur(left)),
                  h('div', { class: 'dbbar', style: 'width:110px' }, h('i', { style: `width:${pct}%;background:${pct < 20 ? 'var(--danger)' : 'var(--accent)'}` }))]),
                h('td', { class: 'num' }, fmtDur(l.granted)),
                h('td', null, l.nKeys ? h('button', { class: 'btn sm ghost', onClick: () => { L.open[l.id] = !open; update(); } }, icon('chevron', open ? 'rot' : ''), pl(l.nKeys, 'klucz', 'klucze', 'kluczy')) : h('span', { class: 'muted' }, 'brak')),
                h('td', null, h('div', { class: 'actions' },
                  !ro && h('button', { class: 'btn sm', onClick: () => keepAlive(l).catch(toastErr) }, 'Odnów'),
                  !ro && h('button', { class: 'btn sm danger', onClick: () => revoke(l).catch(toastErr) }, 'Unieważnij')))),
              open && h('tr', { key: l.id + '-k' }, h('td', { colspan: 5, style: 'background:var(--panel-2)' },
                h('div', { class: 'stack', style: 'gap:2px' }, l.keys.map((k) => h('a', { href: '#', class: 'mono', onClick: (e) => { e.preventDefault(); openKey(k.k, k.s); } }, k.s)),
                  l.nKeys > l.keys.length && h('span', { class: 'muted' }, `… i ${fmtNum(l.nKeys - l.keys.length)} więcej`)))),
            ];
          }))))));
}

export function leasesNeedTick() { return S.view === 'leases' && L.list && L.list.length > 0; }
export function resetLeases() { L.list = null; L.err = ''; L.open = {}; }

// ---------- auth ----------

const A = { data: null, loading: false, err: '' };

export async function loadAuth() {
  A.loading = true; update();
  try { A.data = await api('/api/auth'); A.err = ''; }
  catch (e) { A.err = e.message; }
  finally { A.loading = false; update(); }
}

async function userOp(body, msg) {
  await api('/api/auth/user', body);
  if (msg) toast(msg);
  loadAuth();
}
async function roleOp(body, msg) {
  await api('/api/auth/role', body);
  if (msg) toast(msg);
  loadAuth();
}

function addUserModal() {
  return openModal((m) => ({
    title: 'Nowy użytkownik',
    body: [
      h('label', { class: 'field' }, h('span', null, 'Nazwa'), h('input', { class: 'input', value: m.name, mount: (el) => el.focus(), onInput: (e) => { m.name = e.target.value; update(); } })),
      !m.noPassword && h('label', { class: 'field' }, h('span', null, 'Hasło'), h('input', { class: 'input', type: 'password', autocomplete: 'new-password', value: m.password, onInput: (e) => { m.password = e.target.value; update(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.noPassword, onChange: (e) => { m.noPassword = e.target.checked; update(); } }), 'Bez hasła (logowanie tylko certyfikatem klienta, CN = nazwa)'),
      h('label', { class: 'field' }, h('span', null, 'Rola (opcjonalnie)'),
        h('select', { class: 'input', value: m.role, onChange: (e) => { m.role = e.target.value; } }, h('option', { value: '' }, '– bez roli –'), (A.data.roles || []).map((r) => h('option', { value: r.name }, r.name)))),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !m.name || m.busy, onClick: () => busy(m, 'busy', async () => {
        await api('/api/auth/user', { action: 'add', name: m.name, password: m.password, noPassword: m.noPassword });
        if (m.role) await api('/api/auth/user', { action: 'grant', name: m.name, role: m.role });
        toast(`Utworzono użytkownika ${m.name}`);
        m.close(); loadAuth();
      }) }, 'Utwórz użytkownika'),
    ],
  }), { name: '', password: '', noPassword: false, role: '' });
}

function passwdModal(u) {
  return openModal((m) => ({
    title: `Zmień hasło: ${u.name}`,
    body: [h('label', { class: 'field' }, h('span', null, 'Nowe hasło'), h('input', { class: 'input', type: 'password', autocomplete: 'new-password', value: m.password, mount: (el) => el.focus(), onInput: (e) => { m.password = e.target.value; update(); } }))],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !m.password || m.busy, onClick: () => busy(m, 'busy', async () => { await userOp({ action: 'passwd', name: u.name, password: m.password }, 'Zmieniono hasło'); m.close(); }) }, 'Zmień hasło'),
    ],
  }), { password: '' });
}

function grantPermModal(role) {
  return openModal((m) => ({
    title: `Nadaj uprawnienie roli ${role.name}`,
    body: [
      h('div', { class: 'field' }, h('span', null, 'Zakres'),
        h('div', { class: 'seg' }, [['prefix', 'Prefiks'], ['single', 'Jeden klucz'], ['range', 'Zakres'], ['all', 'Wszystkie klucze']].map(([k, l]) =>
          h('button', { class: m.kind === k ? 'on' : '', onClick: () => { m.kind = k; update(); } }, l)))),
      m.kind !== 'all' && h('label', { class: 'field' }, h('span', null, m.kind === 'prefix' ? 'Prefiks' : m.kind === 'single' ? 'Klucz' : 'Początek zakresu (włącznie)'),
        h('input', { class: 'input mono', value: m.key, onInput: (e) => { m.key = e.target.value; update(); } })),
      m.kind === 'range' && h('label', { class: 'field' }, h('span', null, 'Koniec zakresu (wyłącznie)'), h('input', { class: 'input mono', value: m.end, onInput: (e) => { m.end = e.target.value; update(); } })),
      h('div', { class: 'field' }, h('span', null, 'Uprawnienie'),
        h('div', { class: 'seg' }, [['READ', 'Odczyt'], ['WRITE', 'Zapis'], ['READWRITE', 'Odczyt i zapis']].map(([k, l]) =>
          h('button', { class: m.perm === k ? 'on' : '', onClick: () => { m.perm = k; update(); } }, l)))),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: m.busy || (m.kind !== 'all' && !m.key), onClick: () => busy(m, 'busy', async () => {
        await roleOp({ action: 'grant', name: role.name, kind: m.kind, key: strToB64(m.key), rangeEnd: strToB64(m.end), perm: m.perm }, 'Nadano uprawnienie');
        m.close();
      }) }, 'Nadaj uprawnienie'),
    ],
  }), { kind: 'prefix', key: '', end: '', perm: 'READ' });
}

function addRoleModal() {
  return openModal((m) => ({
    title: 'Nowa rola',
    body: [h('label', { class: 'field' }, h('span', null, 'Nazwa roli'), h('input', { class: 'input', value: m.name, mount: (el) => el.focus(), onInput: (e) => { m.name = e.target.value; update(); } }))],
    actions: [
      h('button', { class: 'btn', onClick: () => m.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !m.name || m.busy, onClick: () => busy(m, 'busy', async () => { await roleOp({ action: 'add', name: m.name }, `Utworzono rolę ${m.name}`); m.close(); }) }, 'Utwórz rolę'),
    ],
  }), { name: '' });
}

function permLabel(p) {
  const t = { READ: 'odczyt', WRITE: 'zapis', READWRITE: 'odczyt i zapis' }[p.type] || p.type;
  const where = p.kind === 'all' ? 'wszystkie klucze' : p.kind === 'prefix' ? `${p.keyS}*` : p.kind === 'single' ? p.keyS : p.kind === 'fromkey' ? `od ${p.keyS}` : `[${p.keyS}, ${p.endS})`;
  return [h('span', { class: 'badge' }, t), ' ', h('span', { class: 'mono' }, where)];
}

async function toggleAuth(enable) {
  const ok = await confirmDanger({
    title: enable ? 'Włączyć uwierzytelnianie?' : 'Wyłączyć uwierzytelnianie?',
    message: enable ? 'Od tej chwili każdy klient musi się logować. Upewnij się, że aplikacje mają skonfigurowane konta – inaczej stracą dostęp do etcd. Ten profil musi mieć użytkownika z rolą root, aby dalej zarządzać klastrem.'
      : 'Każdy, kto ma dostęp sieciowy do klastra, uzyska pełny dostęp do danych bez logowania.',
    confirm: enable ? 'Włącz uwierzytelnianie' : 'Wyłącz uwierzytelnianie',
  });
  if (!ok) return;
  await api('/api/auth/toggle', { enable });
  if (enable && !S.profile.username) {
    toast('Uwierzytelnianie włączone – połącz się ponownie jako użytkownik z rolą root');
    if (hooks.disconnect) hooks.disconnect();
    return;
  }
  toast(enable ? 'Uwierzytelnianie włączone' : 'Uwierzytelnianie wyłączone');
  loadAuth();
}

export function AuthView() {
  if (!A.data && !A.loading && !A.err) loadAuth();
  const d = A.data;
  const ro = S.profile.readOnly;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Dostęp'), h('p', null, 'Użytkownicy, role i uprawnienia do zakresów kluczy.')),
      A.loading && h('span', { class: 'spinner' }),
      h('button', { class: 'btn', onClick: loadAuth }, icon('refresh'), 'Odśwież')),
    A.err && h('div', { class: 'banner danger' }, icon('alert'), A.err),
    d && [
      h('div', { class: 'panel', style: 'margin-bottom:16px' },
        h('div', { class: 'panel-h' },
          h('div', { class: 'grow' },
            h('h2', null, 'Uwierzytelnianie ', d.enabled ? h('span', { class: 'badge ok' }, 'włączone') : d.enabled === false ? h('span', { class: 'badge danger' }, 'wyłączone') : null),
            h('p', null, d.statusError ? d.statusError : d.enabled ? `Zalogowano jako ${d.currentUser || '(certyfikat klienta)'}.` : 'Każdy klient ma pełny dostęp do wszystkich kluczy.')),
          !ro && d.enabled != null && h('button', { class: d.enabled ? 'btn danger' : 'btn primary', onClick: () => toggleAuth(!d.enabled).catch(toastErr) }, d.enabled ? 'Wyłącz' : 'Włącz'))),
      h('div', { class: 'grid2' },
        h('div', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', { class: 'grow' }, 'Użytkownicy'), !ro && h('button', { class: 'btn sm', onClick: addUserModal }, icon('plus'), 'Dodaj')),
          d.usersError ? h('div', { class: 'panel-b err-text' }, d.usersError)
            : d.users.length === 0 ? h('div', { class: 'empty' }, h('b', null, 'Brak użytkowników'), 'Przed włączeniem uwierzytelniania utwórz użytkownika root z rolą root.')
              : h('table', { class: 't' }, h('tbody', null, d.users.map((u) => h('tr', { key: u.name },
                h('td', null, h('div', { class: 'row' }, icon('user'), h('b', null, u.name))),
                h('td', null, h('div', { class: 'row wrap', style: 'gap:4px' },
                  u.roles.map((r) => h('span', { class: 'badge accent' }, r, !ro && h('button', { class: 'btn ghost', title: `Odbierz rolę ${r}`, style: 'height:16px;padding:0 0 0 4px;border:0;background:none;color:inherit', onClick: () => userOp({ action: 'revoke', name: u.name, role: r }, `Odebrano rolę ${r}`).catch(toastErr) }, '×'))),
                  !ro && h('select', { class: 'input', style: 'height:22px;font-size:12px;padding:0 4px', value: '', onChange: (e) => { const r = e.target.value; e.target.value = ''; if (r) userOp({ action: 'grant', name: u.name, role: r }, `Nadano rolę ${r}`).catch(toastErr); } },
                    h('option', { value: '' }, '+ rola'), d.roles.filter((r) => !u.roles.includes(r.name)).map((r) => h('option', { value: r.name }, r.name))))),
                h('td', null, !ro && h('div', { class: 'actions' },
                  h('button', { class: 'btn sm', onClick: () => passwdModal(u) }, 'Hasło…'),
                  h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmDanger({ title: `Usunąć użytkownika ${u.name}?`, message: 'Aplikacje korzystające z tego konta stracą dostęp.', confirm: 'Usuń użytkownika' })) userOp({ action: 'delete', name: u.name }, 'Usunięto użytkownika').catch(toastErr); } }, icon('trash'))))))))),
        h('div', { class: 'panel' },
          h('div', { class: 'panel-h' }, h('h2', { class: 'grow' }, 'Role'), !ro && h('button', { class: 'btn sm', onClick: addRoleModal }, icon('plus'), 'Dodaj')),
          d.rolesError ? h('div', { class: 'panel-b err-text' }, d.rolesError)
            : d.roles.length === 0 ? h('div', { class: 'empty' }, h('b', null, 'Brak ról'), 'Rola root daje pełny dostęp; inne role nadają uprawnienia do wybranych kluczy.')
              : h('div', null, d.roles.map((r) => h('div', { key: r.name, class: 'panel-b', style: 'border-bottom:1px solid var(--line-2)' },
                h('div', { class: 'row' }, h('b', { class: 'grow' }, r.name), r.name === 'root' && h('span', { class: 'badge leader' }, 'pełny dostęp'),
                  !ro && r.name !== 'root' && h('button', { class: 'btn sm', onClick: () => grantPermModal(r) }, icon('plus'), 'Uprawnienie'),
                  !ro && h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmDanger({ title: `Usunąć rolę ${r.name}?`, message: 'Użytkownicy z tą rolą stracą jej uprawnienia.', confirm: 'Usuń rolę' })) roleOp({ action: 'delete', name: r.name }, 'Usunięto rolę').catch(toastErr); } }, icon('trash'))),
                r.perms.length > 0 && h('div', { class: 'stack', style: 'gap:4px;margin-top:8px' }, r.perms.map((p) => h('div', { class: 'row' },
                  h('span', { class: 'grow' }, permLabel(p)),
                  !ro && h('button', { class: 'btn sm ghost', title: 'Odbierz uprawnienie', onClick: () => roleOp({ action: 'revoke', name: r.name, key: p.key, rangeEnd: p.rangeEnd }, 'Odebrano uprawnienie').catch(toastErr) }, icon('x')))))))))),
    ]);
}

export function resetAuth() { A.data = null; A.err = ''; }

// ---------- watch ----------

const W = { prefix: '', isPrefix: true, fromRev: '', es: null, events: [], paused: false, status: '', err: '', open: null, seq: 0, rev: 0 };

export function watchPrefix(p) {
  stopWatch();
  W.prefix = p; W.isPrefix = true; W.fromRev = '';
  S.view = 'watch';
  startWatch();
}

export function stopWatch() {
  if (W.es) { W.es.close(); W.es = null; }
  W.status = '';
  update();
}

function startWatch() {
  stopWatch();
  W.err = '';
  const url = '/api/watch?' + q({ p: strToB64(W.prefix), prefix: W.isPrefix ? 1 : 0, rev: W.fromRev || undefined, t: S.token });
  const es = new EventSource(url);
  W.es = es; W.status = 'connecting';
  es.addEventListener('created', (e) => { W.status = 'live'; W.rev = JSON.parse(e.data).rev; update(); });
  es.addEventListener('progress', (e) => { W.rev = JSON.parse(e.data).rev; update(); });
  es.addEventListener('events', (e) => {
    const d = JSON.parse(e.data);
    W.rev = d.rev;
    if (W.paused) return;
    for (const ev of d.events) W.events.unshift({ ...ev, id: ++W.seq, at: new Date() });
    if (W.events.length > 2000) W.events.length = 2000;
    update();
  });
  es.addEventListener('error', (e) => {
    if (e.data) { W.err = JSON.parse(e.data).error; }
    else if (es.readyState === EventSource.CLOSED) W.err = W.err || 'Obserwacja przerwana';
    else return; // browser reconnects by itself
    es.close(); W.es = null; W.status = ''; update();
  });
  update();
}

function preview(b64, size) {
  const t = b64ToText(b64);
  if (t == null) return `(binarne, ${fmtSize(size)})`;
  const one = t.replace(/\s+/g, ' ');
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}

function full(b64, size) {
  const t = b64ToText(b64);
  const trunc = size > 16384 ? `\n… (obcięto, całość: ${fmtSize(size)})` : '';
  if (t == null) return h('pre', { html: hexdump(b64ToBytes(b64), 4096) });
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return h('pre', null, JSON.stringify(j, null, 2) + trunc); } catch { /* not json */ }
  return h('pre', null, t + trunc);
}

export function WatchView() {
  const live = !!W.es;
  return h('div', { class: 'page', style: 'display:flex;flex-direction:column' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Obserwacja'), h('p', null, 'Zmiany kluczy na żywo (watch). Z rewizją początkową możesz też odtworzyć zmiany z przeszłości.'))),
    h('form', { class: 'panel panel-b row wrap', style: 'margin-bottom:12px', onSubmit: (e) => { e.preventDefault(); startWatch(); } },
      h('input', { class: 'input mono grow', style: 'min-width:240px', placeholder: 'np. /config/ – puste = wszystkie klucze', value: W.prefix, disabled: live, onInput: (e) => { W.prefix = e.target.value; update(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: W.isPrefix, disabled: live, onChange: (e) => { W.isPrefix = e.target.checked; update(); } }), 'jako prefiks'),
      h('input', { class: 'input mono', style: 'width:150px', type: 'number', min: 1, placeholder: 'od rewizji', disabled: live, value: W.fromRev, onInput: (e) => { W.fromRev = e.target.value; update(); } }),
      live ? h('button', { class: 'btn', type: 'button', onClick: stopWatch }, icon('stop'), 'Zatrzymaj')
        : h('button', { class: 'btn primary', type: 'submit' }, icon('play'), 'Obserwuj'),
      h('button', { class: 'btn ghost', type: 'button', disabled: !live, onClick: () => { W.paused = !W.paused; update(); } }, icon(W.paused ? 'play' : 'pause'), W.paused ? 'Wznów' : 'Wstrzymaj'),
      h('button', { class: 'btn ghost', type: 'button', disabled: !W.events.length, onClick: () => { W.events = []; update(); } }, 'Wyczyść'),
      h('span', { class: 'muted', style: 'font-size:12.5px' },
        W.status === 'live' ? (W.paused ? 'wstrzymano' : `na żywo, rewizja ${fmtNum(W.rev)}`) : W.status === 'connecting' ? 'łączenie…' : '')),
    W.err && h('div', { class: 'banner danger' }, icon('alert'), W.err),
    h('div', { class: 'panel', style: 'flex:1;min-height:0;overflow:auto' },
      W.events.length === 0 ? h('div', { class: 'empty' }, h('b', null, live ? 'Czekam na zmiany…' : 'Brak zdarzeń'), live ? 'Zdarzenia pojawią się tutaj, gdy ktoś zmieni klucze w obserwowanym zakresie.' : 'Podaj prefiks i kliknij „Obserwuj”.')
        : h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', null, 'Czas'), h('th', null, 'Typ'), h('th', null, 'Klucz'), h('th', { class: 'r' }, 'Rewizja'), h('th', null, 'Wartość'))),
          h('tbody', null, W.events.slice(0, 500).map((ev) => [
            h('tr', { key: ev.id, class: 'evt', onClick: () => { W.open = W.open === ev.id ? null : ev.id; update(); } },
              h('td', { class: 'mono num muted' }, ev.at.toLocaleTimeString('pl-PL')),
              h('td', null, h('span', { class: 'evt-type ' + ev.type }, ev.type)),
              h('td', { class: 'mono', style: 'word-break:break-all' }, ev.s),
              h('td', { class: 'r mono num' }, fmtNum(ev.mod)),
              h('td', { class: 'mono muted ellipsis', style: 'max-width:420px' }, ev.type === 'DELETE' ? (ev.prev != null ? 'było: ' + preview(ev.prev, ev.prevSize) : '') : preview(ev.v, ev.size))),
            W.open === ev.id && h('tr', { key: ev.id + 'd', class: 'evt-detail' }, h('td', { colspan: 5 },
              h('div', { class: 'grid2' },
                ev.type !== 'DELETE' && h('div', null, h('div', { class: 'muted', style: 'margin-bottom:4px' }, `Nowa wartość (wersja ${ev.ver})`), full(ev.v, ev.size)),
                ev.prev != null && h('div', null, h('div', { class: 'muted', style: 'margin-bottom:4px' }, 'Poprzednia wartość'), full(ev.prev, ev.prevSize))),
              ev.type !== 'DELETE' && h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', onClick: () => openKey(ev.k, ev.s) }, 'Otwórz klucz')))),
          ])))));
}

export function resetWatch() { stopWatch(); W.events = []; W.err = ''; }
