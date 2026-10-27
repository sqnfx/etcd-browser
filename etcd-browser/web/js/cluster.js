// Cluster members and maintenance (compaction, defragmentation, alarms, consistency, snapshots).
import {
  h, S, update, api, icon, toast, toastErr, ask, confirmDanger, openModal, busy, copyText, download, fileURL,
  fmtNum, fmtSize, fmtMs, pl, plural, memberName, isProd,
} from './core.js';

export const CL = { loading: false, defrag: {}, hash: null, hashing: false, wizard: null, compact: { mode: 'keep', keep: '1000', rev: '', physical: true } };

export async function loadCluster(quiet) {
  if (CL.loading) return;
  CL.loading = true;
  if (!quiet) update();
  try {
    S.cluster = await api('/api/cluster');
    S.clusterErr = '';
  } catch (e) {
    S.clusterErr = e.message;
  } finally {
    CL.loading = false;
    update();
  }
}

export function health(c) {
  if (!c) return { up: 0, total: 0, voters: 0, votersUp: 0 };
  const total = c.members.length;
  const up = c.members.filter((m) => m.status && !(m.status.errors || []).length).length;
  const voters = c.members.filter((m) => !m.isLearner).length;
  const votersUp = c.members.filter((m) => !m.isLearner && m.status).length;
  return { up, total, voters, votersUp, quorum: votersUp > voters / 2 };
}

function roleBadge(m) {
  if (m.isLeader) return h('span', { class: 'badge leader' }, 'lider');
  if (m.isLearner) return h('span', { class: 'badge' }, 'learner');
  if (!m.status) return h('span', { class: 'badge danger' }, 'niedostępny');
  return h('span', { class: 'badge' }, 'follower');
}

function dbCell(st) {
  if (!st) return h('span', { class: 'muted' }, '–');
  const quota = st.dbSizeQuota || 2 * 1024 * 1024 * 1024;
  const pctUse = Math.min(100, (st.dbSizeInUse / quota) * 100);
  const pctFree = Math.min(100 - pctUse, ((st.dbSize - st.dbSizeInUse) / quota) * 100);
  return h('div', { title: `Plik: ${fmtSize(st.dbSize)}\nW użyciu: ${fmtSize(st.dbSizeInUse)}\nDo odzyskania defragmentacją: ${fmtSize(st.dbSize - st.dbSizeInUse)}\nLimit (quota): ${fmtSize(quota)}` },
    h('div', { class: 'num' }, fmtSize(st.dbSize), h('span', { class: 'muted' }, ` / ${fmtSize(quota)}`)),
    h('div', { class: 'dbbar' }, h('i', { style: `width:${pctUse}%` }), h('i', { class: 'free', style: `width:${pctFree}%` })));
}

function membersTable(c, opts = {}) {
  const ro = S.profile.readOnly;
  return h('div', { class: 'panel', style: 'overflow:auto' },
    h('table', { class: 't' },
      h('thead', null, h('tr', null,
        h('th', null, 'Członek'), h('th', null, 'Adres klienta'), h('th', null, 'Wersja'), h('th', null, 'Baza danych'),
        h('th', { class: 'r' }, 'Raft (term / indeks)'), h('th', { class: 'r' }, 'Opóźnienie'), h('th', { class: 'r' }, ''))),
      h('tbody', null, c.members.map((m) => {
        const st = m.status;
        const errs = (st && st.errors) || [];
        return h('tr', { key: m.id },
          h('td', null,
            h('div', { class: 'member-name' }, m.name || h('span', { class: 'muted' }, '(nieuruchomiony)'), roleBadge(m)),
            h('div', { class: 'mono muted', style: 'font-size:11.5px' }, m.id)),
          h('td', null,
            h('div', { class: 'mono' }, m.endpoint || '–'),
            m.override && h('div', { class: 'muted', style: 'font-size:11.5px' }, 'adres ustawiony ręcznie'),
            m.error && h('div', { class: 'err-text', style: 'max-width:340px' }, m.error),
            errs.map((e) => h('div', { class: 'err-text' }, e))),
          h('td', { class: 'mono' }, st ? st.version : '–'),
          h('td', null, dbCell(st)),
          h('td', { class: 'r mono num' }, st ? `${fmtNum(st.raftTerm)} / ${fmtNum(st.raftIndex)}` : '–'),
          h('td', { class: 'r num' }, m.status ? `${m.latencyMs} ms` : '–'),
          h('td', null, h('div', { class: 'actions' }, opts.actions ? opts.actions(m) : memberActions(m, ro))));
      }))));
}

function memberActions(m, ro) {
  const out = [];
  if (!m.status || m.override) out.push(h('button', { class: 'btn sm', onClick: () => overrideModal(m) }, icon('link'), 'Adres…'));
  if (ro) return out;
  if (m.isLearner && m.status) out.push(h('button', { class: 'btn sm', onClick: () => promote(m).catch(toastErr) }, 'Promuj'));
  if (!m.isLeader && !m.isLearner && m.status) out.push(h('button', { class: 'btn sm', title: 'Przekaż rolę lidera temu członkowi', onClick: () => moveLeader(m).catch(toastErr) }, icon('crown'), 'Lider'));
  out.push(h('button', { class: 'btn sm', onClick: () => peerModal(m) }, 'Peer URL…'));
  out.push(h('button', { class: 'btn sm danger', onClick: () => removeMember(m).catch(toastErr) }, icon('trash')));
  return out;
}

async function promote(m) {
  const ok = await ask({ title: `Promować ${m.name}?`, message: 'Learner stanie się pełnoprawnym członkiem z prawem głosu. etcd odrzuci operację, jeśli learner nie dogonił jeszcze lidera.', confirm: 'Promuj' });
  if (!ok) return;
  await api('/api/members/promote', { id: m.id });
  toast(`${m.name} jest teraz członkiem z prawem głosu`);
  loadCluster(true);
}

async function moveLeader(m) {
  const ok = await ask({ title: `Przekazać przywództwo do ${m.name}?`, message: 'Obecny lider przekaże rolę wskazanemu członkowi. Na chwilę może wzrosnąć opóźnienie zapisów.', confirm: 'Przekaż przywództwo' });
  if (!ok) return;
  await api('/api/members/leader', { id: m.id });
  toast(`Liderem jest teraz ${m.name}`);
  setTimeout(() => loadCluster(true), 400);
}

async function removeMember(m) {
  const h1 = health(S.cluster);
  const warn = !m.isLearner && h1.voters - 1 < 3 ? ' Po usunięciu klaster będzie mieć mniej niż 3 członków z prawem głosu – utrata kolejnego węzła zatrzyma zapisy.' : '';
  const ok = await confirmDanger({ title: `Usunąć członka ${m.name || m.id}?`, message: `Członek zostanie usunięty z klastra, a jego proces etcd zatrzyma się sam.${warn} Dane na jego dysku pozostaną.`, confirm: 'Usuń członka', typeToConfirm: isProd() ? '' : (m.name || m.id) });
  if (!ok) return;
  await api('/api/members/remove', { id: m.id });
  toast(`Usunięto członka ${m.name || m.id}`);
  loadCluster(true);
}

function peerModal(m) {
  return openModal((md) => ({
    title: `Adresy peer: ${m.name || m.id}`,
    body: [
      h('p', { class: 'muted' }, 'Adresy, pod którymi pozostali członkowie łączą się z tym węzłem (zwykle port 2380).'),
      h('textarea', { class: 'input', rows: 3, value: md.urls, onInput: (e) => { md.urls = e.target.value; update(); } }),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => md.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: md.busy, onClick: () => busy(md, 'busy', async () => {
        await api('/api/members/update', { id: m.id, peerURLs: [md.urls] });
        toast('Zaktualizowano adresy peer');
        md.close(); loadCluster(true);
      }) }, 'Zapisz'),
    ],
  }), { urls: m.peerURLs.join('\n') });
}

function overrideModal(m) {
  return openModal((md) => ({
    title: `Adres klienta: ${m.name || m.id}`,
    body: [
      h('p', null, 'Klaster rozgłasza dla tego członka ', h('span', { class: 'mono' }, m.clientURLs.join(', ') || '(brak)'),
        '. Jeśli ten adres nie jest osiągalny z Twojego komputera (np. sieć wewnętrzna, Kubernetes), podaj adres, pod którym go widzisz – na przykład przekierowany port.'),
      h('input', { class: 'input mono', placeholder: '127.0.0.1:32379', value: md.url, mount: (el) => el.focus(), onInput: (e) => { md.url = e.target.value; update(); } }),
      h('small', { class: 'muted' }, 'Adres zapisuje się w profilu połączenia. Służy do statusu, defragmentacji, snapshotów i sumy kontrolnej tego członka.'),
    ],
    actions: [
      m.override && h('button', { class: 'btn ghost', onClick: () => busy(md, 'busy', async () => { await api('/api/members/override', { id: m.id, url: '' }); md.close(); loadCluster(true); }) }, 'Przywróć rozgłaszany'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onClick: () => md.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !md.url || md.busy, onClick: () => busy(md, 'busy', async () => {
        await api('/api/members/override', { id: m.id, url: md.url });
        md.close(); loadCluster(true);
      }) }, 'Zapisz adres'),
    ],
  }), { url: m.override || '' });
}

function addMemberModal() {
  return openModal((md) => md.result ? ({
    title: 'Członek dodany',
    wide: true,
    body: [
      h('p', null, 'Uruchom teraz etcd na nowym węźle z poniższą konfiguracją (zmienne środowiskowe). Dopóki tego nie zrobisz, klaster będzie widział członka jako nieuruchomionego.'),
      h('div', { class: 'codebox' }, md.result.env.join('\n')),
      md.learner && h('p', { class: 'muted' }, 'Gdy learner dogoni lidera, wróć tutaj i kliknij „Promuj”.'),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => copyText(md.result.env.join('\n')) }, icon('copy'), 'Kopiuj'),
      h('button', { class: 'btn primary', onClick: () => md.close() }, 'Gotowe'),
    ],
  }) : ({
    title: 'Dodaj członka',
    body: [
      h('label', { class: 'field' }, h('span', null, 'Nazwa nowego członka'), h('input', { class: 'input', placeholder: 'etcd-4', value: md.name, mount: (el) => el.focus(), onInput: (e) => { md.name = e.target.value; update(); } })),
      h('label', { class: 'field' }, h('span', null, 'Adres peer'), h('input', { class: 'input mono', placeholder: 'https://10.0.0.4:2380', value: md.urls, onInput: (e) => { md.urls = e.target.value; update(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: md.learner, onChange: (e) => { md.learner = e.target.checked; update(); } }),
        'Dodaj jako learner (zalecane) – nie głosuje, dopóki nie dogoni danych'),
    ],
    actions: [
      h('button', { class: 'btn', onClick: () => md.close() }, 'Anuluj'),
      h('button', { class: 'btn primary', disabled: !md.urls || md.busy, onClick: () => busy(md, 'busy', async () => {
        md.result = await api('/api/members/add', { peerURLs: [md.urls], learner: md.learner, name: md.name });
        loadCluster(true);
      }) }, 'Dodaj członka'),
    ],
  }), { name: '', urls: '', learner: true });
}

export function ClusterView() {
  const c = S.cluster;
  if (!c) return h('div', { class: 'page' }, S.clusterErr ? h('div', { class: 'banner danger' }, icon('alert'), S.clusterErr) : h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  const hh = health(c);
  const leader = c.members.find((m) => m.isLeader);
  const unreachable = c.members.filter((m) => !m.status);
  const total = c.members.reduce((a, m) => a + (m.status ? m.status.dbSize : 0), 0);
  const versions = [...new Set(c.members.filter((m) => m.status).map((m) => m.status.version))];
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Klaster'), h('p', null, `Członkowie wykryci przez połączenie z ${c.endpoints.join(', ')}`)),
      CL.loading && h('span', { class: 'spinner' }),
      h('button', { class: 'btn', onClick: () => loadCluster() }, icon('refresh'), 'Odśwież'),
      !S.profile.readOnly && h('button', { class: 'btn primary', onClick: addMemberModal }, icon('plus'), 'Dodaj członka')),
    !hh.quorum && h('div', { class: 'banner danger' }, icon('alert'), h('div', null, h('b', null, 'Brak kworum. '), `Osiągalnych jest ${hh.votersUp} z ${hh.voters} członków z prawem głosu – klaster nie przyjmie zapisów.`)),
    c.alarms.length > 0 && h('div', { class: 'banner danger' }, icon('alert'), h('div', null, h('b', null, 'Aktywne alarmy: '), c.alarms.map((a) => `${a.alarm} (${memberName(a.member)})`).join(', '), '. Przejdź do konserwacji, aby je usunąć.')),
    unreachable.length > 0 && hh.quorum && h('div', { class: 'banner' }, icon('alert'), h('div', null,
      `${pl(unreachable.length, 'członek jest nieosiągalny', 'członków jest nieosiągalnych', 'członków jest nieosiągalnych')} z tego komputera. `,
      'Jeśli działają, a klaster rozgłasza adresy niedostępne z Twojej sieci, ustaw adres ręcznie przyciskiem „Adres…”.')),
    h('div', { class: 'facts' },
      h('div', { class: 'fact' }, h('span', null, 'Identyfikator klastra'), h('b', { class: 'mono' }, c.clusterId)),
      h('div', { class: 'fact' }, h('span', null, 'Lider'), h('b', null, leader ? leader.name : 'brak')),
      h('div', { class: 'fact' }, h('span', null, 'Członkowie dostępni'), h('b', null, `${hh.up} z ${hh.total}`)),
      h('div', { class: 'fact' }, h('span', null, versions.length > 1 ? 'Wersje (mieszane)' : 'Wersja etcd'), h('b', { class: 'mono' }, versions.join(', ') || '–')),
      h('div', { class: 'fact' }, h('span', null, 'Bieżąca rewizja'), h('b', { class: 'mono' }, fmtNum(c.revision))),
      h('div', { class: 'fact' }, h('span', null, 'Bazy łącznie'), h('b', null, fmtSize(total)))),
    membersTable(c));
}

// ---------- maintenance ----------

async function doCompact() {
  const c = S.cluster;
  const cf = CL.compact;
  const rev = cf.mode === 'rev' ? +cf.rev : 0;
  const keep = cf.mode === 'keep' ? +cf.keep : 0;
  const target = rev || (c.revision - keep);
  if (target <= (c.compactRevision || 0)) { toast(`Historia do rewizji ${fmtNum(c.compactRevision)} jest już skompaktowana`, 'error'); return; }
  const ok = await confirmDanger({
    title: `Kompaktować do rewizji ${fmtNum(target)}?`,
    message: `Usunie historię wszystkich kluczy sprzed tej rewizji (${pl(target - (c.compactRevision || 0), 'rewizja', 'rewizje', 'rewizji')}). Wartości bieżące pozostaną. Obserwatorzy (watch) i odczyty starszych rewizji otrzymają błąd „compacted”.`,
    confirm: 'Kompaktuj',
  });
  if (!ok) return;
  const r = await api('/api/maint/compact', { revision: rev, keep, physical: cf.physical });
  toast(`Skompaktowano historię do rewizji ${fmtNum(r.revision)} (${fmtMs(r.ms)})`);
  loadCluster(true);
}

async function defragOne(m) {
  CL.defrag[m.id] = { state: 'run' };
  update();
  try {
    const r = await api('/api/maint/defrag', { id: m.id });
    CL.defrag[m.id] = { state: 'done', text: `${fmtSize(r.before)} → ${fmtSize(r.after)} w ${fmtMs(r.ms)}` };
  } catch (e) {
    CL.defrag[m.id] = { state: 'fail', text: e.message };
    throw e;
  } finally { update(); }
}

function defragOrder(c) {
  const live = c.members.filter((m) => m.status);
  return [...live.filter((m) => !m.isLeader), ...live.filter((m) => m.isLeader)];
}

async function defragAll() {
  const order = defragOrder(S.cluster);
  const ok = await ask({ title: 'Defragmentować wszystkich członków?', message: `Po kolei: ${order.map((m) => m.name).join(' → ')}. Lider na końcu. Podczas defragmentacji członek nie odpowiada na żądania (zwykle od kilku sekund do minut).`, confirm: 'Defragmentuj po kolei' });
  if (!ok) return;
  for (const m of order) {
    try { await defragOne(m); } catch (e) { toastErr(e); break; }
  }
  loadCluster(true);
}

async function runHash() {
  CL.hashing = true; update();
  try { CL.hash = await api('/api/maint/hashkv'); }
  catch (e) { toastErr(e); }
  finally { CL.hashing = false; update(); }
}

async function disarm(a) {
  const ok = await ask({ title: `Rozbroić alarm ${a ? a.alarm : 'wszystkie'}?`, message: 'Rozbrój alarm dopiero po usunięciu przyczyny – np. NOSPACE po kompakcji i defragmentacji. Inaczej alarm wróci.', confirm: 'Rozbrój' });
  if (!ok) return;
  await api('/api/maint/disarm', a ? { member: a.member, alarm: a.alarm } : {});
  toast('Alarm rozbrojony');
  loadCluster(true);
}

// wizard: compact → defragment every member → disarm NOSPACE
async function recoverSpace() {
  const c = S.cluster;
  const order = defragOrder(c);
  const ok = await confirmDanger({
    title: 'Odzyskać miejsce?',
    message: `Kompakcja do bieżącej rewizji (bez historii), defragmentacja ${order.map((m) => m.name).join(' → ')} i rozbrojenie alarmu NOSPACE, jeśli jest aktywny.`,
    confirm: 'Rozpocznij',
  });
  if (!ok) return;
  const steps = [{ label: 'Kompakcja do bieżącej rewizji' }, ...order.map((m) => ({ label: `Defragmentacja ${m.name}`, m })), { label: 'Rozbrojenie alarmu NOSPACE' }];
  CL.wizard = { steps };
  update();
  const run = async (s, fn) => { s.state = 'run'; update(); try { s.text = await fn(); s.state = 'done'; } catch (e) { s.state = 'fail'; s.text = e.message; update(); throw e; } update(); };
  try {
    await run(steps[0], async () => {
      try { const r = await api('/api/maint/compact', { revision: 0, keep: 0, physical: true }); return `rewizja ${fmtNum(r.revision)}`; }
      catch (e) { if (/compacted/.test(e.message)) return 'już skompaktowano'; throw e; }
    });
    for (const s of steps.slice(1, -1)) {
      await run(s, async () => { const r = await api('/api/maint/defrag', { id: s.m.id }); return `${fmtSize(r.before)} → ${fmtSize(r.after)}`; });
    }
    await run(steps[steps.length - 1], async () => {
      const al = await api('/api/maint/alarms');
      const nos = al.alarms.filter((a) => a.alarm === 'NOSPACE');
      for (const a of nos) await api('/api/maint/disarm', { member: a.member, alarm: 'NOSPACE' });
      return nos.length ? `rozbrojono ${nos.length}` : 'brak alarmu';
    });
    toast('Miejsce odzyskane');
  } catch (e) { toastErr(e); }
  loadCluster(true);
}

function stepIcon(state) {
  if (!state) return h('span', { class: 'st idle' });
  return h('span', { class: 'st ' + state }, state === 'done' ? icon('check') : state === 'fail' ? icon('x') : null);
}

export function MaintView() {
  const c = S.cluster;
  if (!c) return h('div', { class: 'page' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  const ro = S.profile.readOnly;
  const cf = CL.compact;
  const retained = c.revision - (c.compactRevision || 0);
  const live = c.members.filter((m) => m.status);
  const reclaim = live.reduce((a, m) => a + (m.status.dbSize - m.status.dbSizeInUse), 0);
  const order = defragOrder(c);
  const defragRunning = Object.values(CL.defrag).some((d) => d.state === 'run');
  const target = cf.mode === 'rev' ? +cf.rev || 0 : c.revision - (+cf.keep || 0);

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', null, 'Konserwacja'), h('p', null, 'Operacje wykonywane przez jedno połączenie – na każdym członku osobno, tam gdzie to konieczne.')),
      CL.loading && h('span', { class: 'spinner' }),
      h('button', { class: 'btn', onClick: () => loadCluster() }, icon('refresh'), 'Odśwież')),
    ro && h('div', { class: 'banner info' }, icon('lock'), 'Profil jest w trybie tylko do odczytu – operacje zmieniające klaster są wyłączone.'),
    h('div', { class: 'grid2' },
      // compaction
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Kompakcja'), h('p', null, 'Usuwa starą historię kluczy. Zwolnione miejsce odzyskasz defragmentacją.'))),
        h('div', { class: 'panel-b stack' },
          h('div', { class: 'facts', style: 'margin:0;grid-template-columns:repeat(3,1fr)' },
            h('div', { class: 'fact' }, h('span', null, 'Bieżąca rewizja'), h('b', { class: 'mono' }, fmtNum(c.revision))),
            h('div', { class: 'fact' }, h('span', null, 'Skompaktowano do'), h('b', { class: 'mono' }, c.compactRevision ? fmtNum(c.compactRevision) : 'nigdy')),
            h('div', { class: 'fact' }, h('span', null, 'Historia w bazie'), h('b', null, pl(retained, 'rewizja', 'rewizje', 'rewizji')))),
          h('div', { class: 'seg' },
            h('button', { class: cf.mode === 'keep' ? 'on' : '', onClick: () => { cf.mode = 'keep'; update(); } }, 'Zachowaj ostatnie N rewizji'),
            h('button', { class: cf.mode === 'all' ? 'on' : '', onClick: () => { cf.mode = 'all'; cf.keep = '0'; update(); } }, 'Do bieżącej'),
            h('button', { class: cf.mode === 'rev' ? 'on' : '', onClick: () => { cf.mode = 'rev'; update(); } }, 'Do rewizji')),
          cf.mode === 'keep' && h('label', { class: 'field' }, h('span', null, 'Ile ostatnich rewizji zachować'), h('input', { class: 'input mono', type: 'number', min: 0, value: cf.keep, onInput: (e) => { cf.keep = e.target.value; update(); } })),
          cf.mode === 'rev' && h('label', { class: 'field' }, h('span', null, 'Kompaktuj do rewizji'), h('input', { class: 'input mono', type: 'number', min: 1, max: c.revision, value: cf.rev, onInput: (e) => { cf.rev = e.target.value; update(); } })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cf.physical, onChange: (e) => { cf.physical = e.target.checked; update(); } }), 'Czekaj, aż kompakcja zostanie fizycznie zastosowana'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', disabled: ro || CL.compacting || target <= (c.compactRevision || 0) || target > c.revision, onClick: () => busy(CL, 'compacting', doCompact) },
              CL.compacting && h('span', { class: 'spinner' }), target > 0 ? `Kompaktuj do ${fmtNum(target)}` : 'Kompaktuj'),
            target <= (c.compactRevision || 0) && h('small', { class: 'muted' }, cf.mode === 'keep' ? `Historia jest krótsza niż ${fmtNum(+cf.keep || 0)} ${plural(+cf.keep || 0, 'rewizja', 'rewizje', 'rewizji')} – nie ma czego kompaktować.` : 'Ta rewizja jest już skompaktowana.'),
            target > c.revision && h('small', { class: 'err-text' }, 'Rewizja jest większa od bieżącej.')))),

      // defragmentation
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Defragmentacja'), h('p', null, `Zwraca nieużywane miejsce z pliku bazy. Do odzyskania: ${fmtSize(reclaim)}.`))),
        h('div', { class: 'panel-b stack' },
          h('ul', { class: 'steps' }, c.members.map((m) => {
            const d = CL.defrag[m.id] || {};
            const st = m.status;
            return h('li', { key: m.id },
              stepIcon(d.state),
              h('div', { class: 'grow' },
                h('div', { class: 'row' }, h('b', null, m.name || m.id), m.isLeader && h('span', { class: 'badge leader' }, 'lider'), !st && h('span', { class: 'badge danger' }, 'niedostępny')),
                h('div', { class: d.state === 'fail' ? 'err-text' : 'muted', style: 'font-size:12.5px' },
                  d.text || (st ? `${fmtSize(st.dbSize)}, w użyciu ${fmtSize(st.dbSizeInUse)} – do odzyskania ${fmtSize(st.dbSize - st.dbSizeInUse)}` : (m.error || '')))),
              h('button', { class: 'btn sm', disabled: ro || !st || defragRunning, onClick: async () => {
                const ok = await ask({ title: `Defragmentować ${m.name}?`, message: 'Na czas defragmentacji ten członek nie odpowiada na żądania. Pozostali obsługują klaster normalnie.', confirm: 'Defragmentuj' });
                if (ok) defragOne(m).then(() => loadCluster(true)).catch(toastErr);
              } }, 'Defragmentuj'));
          })),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', disabled: ro || defragRunning || !order.length, onClick: () => defragAll().catch(toastErr) }, defragRunning && h('span', { class: 'spinner' }), 'Defragmentuj wszystkich po kolei'),
            h('small', { class: 'muted' }, 'lider na końcu')))),

      // recovery wizard
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Odzyskiwanie miejsca'), h('p', null, 'Kompakcja, defragmentacja wszystkich członków i rozbrojenie alarmu NOSPACE w jednym kroku.'))),
        h('div', { class: 'panel-b stack' },
          CL.wizard ? h('ul', { class: 'steps' }, CL.wizard.steps.map((s) => h('li', null, stepIcon(s.state), h('div', null, h('div', null, s.label), s.text && h('div', { class: s.state === 'fail' ? 'err-text' : 'muted', style: 'font-size:12.5px' }, s.text)))))
            : h('p', { class: 'muted', style: 'margin:0' }, 'Użyj, gdy baza przekroczyła limit miejsca i klaster przyjmuje tylko odczyty i usuwanie.'),
          h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ro || (CL.wizard && CL.wizard.steps.some((s) => s.state === 'run')), onClick: () => recoverSpace().catch(toastErr) }, 'Odzyskaj miejsce')))),

      // alarms
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Alarmy'), h('p', null, 'NOSPACE blokuje zapisy, CORRUPT oznacza niespójność danych członka.'))),
        h('div', { class: 'panel-b stack' },
          c.alarmError ? h('div', { class: 'err-text' }, c.alarmError)
            : c.alarms.length === 0 ? h('div', { class: 'row' }, h('span', { class: 'badge ok' }, 'brak alarmów'))
              : [h('table', { class: 't' }, h('tbody', null, c.alarms.map((a) => h('tr', null,
                h('td', null, h('span', { class: 'badge danger' }, a.alarm)), h('td', null, memberName(a.member)),
                h('td', { class: 'r' }, !ro && h('button', { class: 'btn sm', onClick: () => disarm(a).catch(toastErr) }, 'Rozbrój')))))),
              !ro && h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => disarm(null).catch(toastErr) }, 'Rozbrój wszystkie'))])),

      // consistency
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Spójność danych'), h('p', null, 'Porównuje sumy kontrolne (HashKV) wszystkich członków przy tej samej rewizji.'))),
        h('div', { class: 'panel-b stack' },
          CL.hash && [
            h('div', null, CL.hash.consistent ? h('span', { class: 'badge ok' }, `Spójne przy rewizji ${fmtNum(CL.hash.revision)}`) : h('span', { class: 'badge danger' }, 'Sumy kontrolne się różnią')),
            h('table', { class: 't' }, h('tbody', null, CL.hash.members.map((m) => h('tr', null,
              h('td', null, h('b', null, m.name)), h('td', { class: 'mono' }, m.hash || h('span', { class: 'err-text' }, m.error)),
              h('td', { class: 'r muted' }, m.compactRevision ? `kompakcja ${fmtNum(m.compactRevision)}` : ''))))),
          ],
          h('div', { class: 'row' }, h('button', { class: 'btn', disabled: CL.hashing, onClick: runHash }, CL.hashing && h('span', { class: 'spinner' }), 'Sprawdź spójność')))),

      // snapshots
      h('div', { class: 'panel' },
        h('div', { class: 'panel-h' }, h('div', { class: 'grow' }, h('h2', null, 'Snapshot'), h('p', null, 'Pełna kopia bazy pobrana z wybranego członka. Przywrócisz ją narzędziem etcdutl.'))),
        h('div', { class: 'panel-b stack' },
          live.map((m) => h('div', { class: 'row', key: m.id },
            h('div', { class: 'grow' }, h('b', null, m.name), h('span', { class: 'muted' }, ` – ${fmtSize(m.status.dbSize)}`)),
            h('button', { class: 'btn sm', onClick: () => { download(fileURL('/api/maint/snapshot', { id: m.id })); toast(`Pobieranie snapshotu z ${m.name}…`); } }, icon('download'), 'Pobierz'))),
          h('small', { class: 'muted' }, 'Kopia zapasowa nie zawiera certyfikatów ani konfiguracji członków.')))));
}

export function needsClusterPoll() { return S.view === 'cluster' || S.view === 'maint'; }
