// Connection screen: saved profiles and the connection form.
import { h, S, update, api, icon, toast, toastErr, ask, readFileText, busy, pl } from './core.js';

const C = { sel: null, form: null, testMsg: '', testOk: false };

function emptyForm() {
  return {
    name: '', endpoints: '127.0.0.1:2379', env: '', readOnly: false, username: '', password: '', savePassword: false,
    hasPassword: false, caCert: '', clientCert: '', clientKey: '', insecureSkipVerify: false, serverName: '',
    dialTimeoutSec: '', requestTimeoutSec: '', autoSync: false, tls: false,
  };
}

function formFromProfile(p) {
  return {
    ...emptyForm(), ...p,
    endpoints: (p.endpoints || []).join('\n'),
    password: '',
    dialTimeoutSec: p.dialTimeoutSec || '', requestTimeoutSec: p.requestTimeoutSec || '',
    tls: !!(p.caCert || p.clientCert || p.insecureSkipVerify || (p.endpoints || []).some((e) => e.startsWith('https://'))),
  };
}

function profileFromForm(f) {
  return {
    name: f.name.trim(),
    endpoints: f.endpoints.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
    env: f.env, readOnly: f.readOnly, username: f.username.trim(), password: f.password, savePassword: f.savePassword,
    caCert: f.tls ? f.caCert : '', clientCert: f.tls ? f.clientCert : '', clientKey: f.tls ? f.clientKey : '',
    insecureSkipVerify: f.tls && f.insecureSkipVerify, serverName: f.tls ? f.serverName.trim() : '',
    dialTimeoutSec: +f.dialTimeoutSec || 0, requestTimeoutSec: +f.requestTimeoutSec || 0, autoSync: f.autoSync,
    overrides: f.overrides,
  };
}

function reqBody() {
  const f = C.form;
  let p = profileFromForm(f);
  if (f.tls && !p.caCert && !p.clientCert && !p.insecureSkipVerify) {
    p.endpoints = p.endpoints.map((e) => (e.includes('://') ? e : 'https://' + e));
  }
  return { profile: p, oldName: C.sel || '', keepPassword: f.hasPassword && !f.password };
}

export async function loadProfiles() {
  const r = await api('/api/profiles');
  S.profiles = r.profiles;
  if (C.form == null) selectProfile(S.profiles.length ? S.profiles[0].name : null);
  update();
}

function selectProfile(name) {
  C.sel = name;
  const p = name && S.profiles.find((x) => x.name === name);
  C.form = p ? formFromProfile(p) : emptyForm();
  C.testMsg = '';
  update();
}

export async function connectWith(body) {
  const r = await api('/api/connect', body);
  S.profile = r.profile;
  S.connected = true;
  S.view = 'keys';
  S.cluster = null;
  document.title = `${r.profile.name} – etcd browser`;
  update();
}

async function save() {
  const f = C.form;
  const body = reqBody();
  if (!body.profile.name) body.profile.name = body.profile.endpoints[0] || '';
  const r = await api('/api/profiles/save', body);
  S.profiles = r.profiles;
  C.sel = r.name;
  const p = S.profiles.find((x) => x.name === r.name);
  if (p) { C.form = { ...formFromProfile(p), tls: f.tls }; }
  toast('Zapisano profil');
}

async function remove() {
  if (!C.sel) return;
  const ok = await ask({ title: 'Usunąć profil?', message: `Profil „${C.sel}” zostanie usunięty z tego komputera. Klaster pozostaje bez zmian.`, confirm: 'Usuń profil', danger: true });
  if (!ok) return;
  const r = await api('/api/profiles/delete', { name: C.sel });
  S.profiles = r.profiles;
  selectProfile(S.profiles.length ? S.profiles[0].name : null);
}

function bind(key, type = 'text') {
  const f = C.form;
  if (type === 'check') return { type: 'checkbox', checked: !!f[key], onChange: (e) => { f[key] = e.target.checked; update(); } };
  return { value: f[key], onInput: (e) => { f[key] = e.target.value; C.testMsg = ''; update(); } };
}

function pemField(key, label, hint) {
  const f = C.form;
  let fileInput;
  return h('div', { class: 'field' },
    h('span', null, label),
    h('textarea', { class: 'input', rows: 3, placeholder: 'Wklej PEM albo podaj ścieżkę do pliku', spellcheck: 'false', ...bind(key) }),
    h('div', { class: 'row' },
      h('input', { type: 'file', style: 'display:none', ref: (el) => (fileInput = el), onChange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try { f[key] = await readFileText(file); update(); } catch (err) { toastErr(err); }
        e.target.value = '';
      } }),
      h('button', { class: 'btn sm', type: 'button', onClick: () => fileInput.click() }, icon('upload'), 'Wczytaj plik'),
      h('small', { class: 'muted' }, hint)));
}

function envSeg() {
  const f = C.form;
  const opts = [['', 'Brak'], ['dev', 'Deweloperskie'], ['test', 'Testowe'], ['prod', 'Produkcyjne']];
  return h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { type: 'button', class: f.env === v ? 'on' : '', onClick: () => { f.env = v; update(); } }, l)));
}

export function ConnectView() {
  if (!C.form) C.form = emptyForm();
  const f = C.form;
  const busyAny = C.connecting || C.testing || C.saving;
  return h('div', { class: 'connect' },
    h('div', { class: 'connect-side' },
      h('svg', { viewBox: '0 0 40 40', width: 40, height: 40, html: LOGO }),
      h('h1', null, 'etcd browser'),
      h('p', null, 'Połącz się z jednym węzłem – pozostałych członków klastra wykryję automatycznie.'),
      h('div', { class: 'plist' },
        S.profiles.map((p) => h('button', { key: p.name, class: 'pitem' + (C.sel === p.name ? ' on' : ''), onClick: () => selectProfile(p.name),
          onDblclick: () => { selectProfile(p.name); doConnect(); } },
          h('span', { class: 'pn' }, h('span', { class: 'ellipsis' }, p.name), p.env && h('span', { class: 'badge env-' + p.env }, envLabel(p.env)), p.readOnly && h('span', { class: 'badge' }, 'tylko odczyt')),
          h('span', { class: 'pe ellipsis' }, (p.endpoints || []).join(', ')))),
        h('button', { class: 'pitem' + (C.sel == null ? ' on' : ''), onClick: () => selectProfile(null) },
          h('span', { class: 'pn' }, icon('plus'), 'Nowe połączenie')))),

    h('form', { class: 'panel', style: 'align-self:start', onSubmit: (e) => { e.preventDefault(); doConnect(); } },
      h('div', { class: 'form-sec' },
        h('div', { class: 'cols2' },
          h('label', { class: 'field' }, h('span', null, 'Nazwa profilu'), h('input', { class: 'input', placeholder: 'np. produkcja-eu', ...bind('name') })),
          h('div', { class: 'field' }, h('span', null, 'Środowisko'), envSeg())),
        h('label', { class: 'field' }, h('span', null, 'Endpointy'),
          h('textarea', { class: 'input', rows: 2, spellcheck: 'false', placeholder: '10.0.0.1:2379', ...bind('endpoints') }),
          h('small', null, 'Wystarczy jeden adres. Kilka adresów (po jednym w wierszu) daje przełączanie awaryjne.')),
        h('div', { class: 'row wrap', style: 'gap:18px' },
          h('label', { class: 'check' }, h('input', bind('readOnly', 'check')), 'Tylko do odczytu – blokuj wszystkie zmiany'),
          f.env === 'prod' && h('small', { class: 'muted' }, 'Na produkcji operacje niszczące wymagają wpisania nazwy profilu.'))),

      h('div', { class: 'form-sec' },
        h('h3', null, 'Uwierzytelnianie'),
        h('div', { class: 'cols2' },
          h('label', { class: 'field' }, h('span', null, 'Użytkownik'), h('input', { class: 'input', autocomplete: 'off', placeholder: 'opcjonalnie', ...bind('username') })),
          h('label', { class: 'field' }, h('span', null, 'Hasło'),
            h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: f.hasPassword ? 'zapisane – zostaw puste, aby użyć' : '', ...bind('password') }))),
        h('label', { class: 'check' }, h('input', bind('savePassword', 'check')), 'Zapamiętaj hasło na tym komputerze (plik konfiguracji z uprawnieniami tylko dla Ciebie)')),

      h('div', { class: 'form-sec' },
        h('label', { class: 'check' }, h('input', bind('tls', 'check')), h('b', { style: 'font-weight:600' }, 'TLS')),
        f.tls && [
          pemField('caCert', 'Certyfikat CA', 'Puste = systemowe CA'),
          h('div', { class: 'cols2' }, pemField('clientCert', 'Certyfikat klienta', 'mTLS'), pemField('clientKey', 'Klucz klienta', 'mTLS')),
          h('div', { class: 'cols2' },
            h('label', { class: 'field' }, h('span', null, 'Nazwa serwera (SNI)'), h('input', { class: 'input', placeholder: 'opcjonalnie', ...bind('serverName') })),
            h('label', { class: 'check', style: 'align-self:end;height:30px' }, h('input', bind('insecureSkipVerify', 'check')), 'Nie weryfikuj certyfikatu serwera'))]),

      h('div', { class: 'form-sec' },
        h('details', { class: 'adv' },
          h('summary', null, icon('chevron'), 'Zaawansowane'),
          h('div', null,
            h('div', { class: 'cols2' },
              h('label', { class: 'field' }, h('span', null, 'Limit czasu połączenia (s)'), h('input', { class: 'input', type: 'number', min: 1, placeholder: '5', ...bind('dialTimeoutSec') })),
              h('label', { class: 'field' }, h('span', null, 'Limit czasu żądania (s)'), h('input', { class: 'input', type: 'number', min: 1, placeholder: '10', ...bind('requestTimeoutSec') }))),
            h('label', { class: 'check' }, h('input', bind('autoSync', 'check')),
              'Używaj adresów wszystkich członków do przełączania awaryjnego (wyłącz, jeśli rozgłaszane adresy są nieosiągalne z tego komputera)')))),

      h('div', { class: 'form-foot' },
        h('button', { class: 'btn primary', type: 'submit', disabled: busyAny }, C.connecting ? h('span', { class: 'spinner' }) : icon('link'), 'Połącz'),
        h('button', { class: 'btn', type: 'button', disabled: busyAny, onClick: () => busy(C, 'testing', test) }, C.testing && h('span', { class: 'spinner' }), 'Testuj'),
        h('button', { class: 'btn', type: 'button', disabled: busyAny, onClick: () => busy(C, 'saving', save) }, 'Zapisz profil'),
        C.testMsg && h('span', { class: C.testOk ? 'badge ok' : 'err-text', style: 'margin-left:6px' }, C.testMsg),
        h('span', { class: 'grow' }),
        C.sel && h('button', { class: 'btn ghost danger', type: 'button', onClick: () => remove().catch(toastErr) }, icon('trash'), 'Usuń profil'))));
}

async function test() {
  C.testMsg = '';
  try {
    const r = await api('/api/test', reqBody());
    C.testOk = true;
    C.testMsg = `Działa – ${pl(r.members, 'członek', 'członkowie', 'członków')} (${r.names.join(', ')}), ${r.ms} ms`;
  } catch (e) {
    C.testOk = false;
    C.testMsg = e.message;
  }
}

async function doConnect() {
  await busy(C, 'connecting', async () => {
    const body = reqBody();
    if (!body.profile.name) body.profile.name = body.profile.endpoints[0] || '';
    // save automatically so the profile is remembered
    const saved = await api('/api/profiles/save', body);
    S.profiles = saved.profiles;
    C.sel = saved.name;
    body.profile.name = saved.name;
    body.oldName = saved.name;
    body.keepPassword = true;
    await connectWith(body);
    C.form.password = C.form.savePassword ? '' : C.form.password;
  });
}

export function envLabel(env) {
  return { dev: 'dev', test: 'test', prod: 'produkcja' }[env] || env;
}

export const LOGO = '<rect x="1" y="1" width="38" height="38" rx="9" fill="var(--accent)"/><g fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"><path d="M11 13h18M11 20h12M11 27h15"/></g><circle cx="29" cy="27" r="3" fill="var(--leader)"/>';
