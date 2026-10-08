import { SignalingClient } from './signaling.js';
import { HostSession } from './host-session.js';
import { ViewerSession } from './viewer-session.js';
import { formatId, randomPassword, reasonText, safeEqual } from './util.js';

const $ = (id) => document.getElementById(id);
const rc = window.rc;

const MAX_FAILED_PASSWORDS = 5;
const LOCKOUT_MS = 5 * 60_000;
const PROMPT_TIMEOUT_S = 55; // a bit under the server's 60s pending timeout
const MAX_RECENT = 8;

const state = {
  config: null,
  password: randomPassword(),
  failedPasswords: [], // timestamps of wrong-password attempts
  host: null, // HostSession
  incoming: null, // pending incoming request awaiting the user's decision
  viewer: null, // ViewerSession
  outgoing: null, // { ref, targetId } while waiting for the server to create the session
};

const signaling = new SignalingClient({
  url: '',
  identity: () => ({
    id: state.config.deviceId ?? undefined,
    token: state.config.deviceToken ?? undefined,
    name: state.config.deviceName,
    platform: state.config.platform,
    version: state.config.version,
  }),
});

init();

async function init() {
  state.config = await rc.getConfig();
  signaling.url = state.config.serverUrl;

  if (state.config.profile) {
    $('profile-tag').textContent = state.config.profile;
    $('profile-tag').hidden = false;
  }
  $('app-version').textContent = state.config.version;
  if (state.config.deviceId) $('my-id').textContent = formatId(state.config.deviceId);
  $('my-password').textContent = state.password;
  renderRecent();
  bindUi();
  bindSignaling();
  bindUpdates();

  const input = await rc.inputStatus();
  if (!input.available) {
    $('input-warning').textContent = `Remote control of this device is unavailable: ${input.reason}`;
    $('input-warning').hidden = false;
  }

  signaling.connect();
}

// ---------------------------------------------------------------- signaling

function bindSignaling() {
  signaling.on('state', renderStatus);

  let autoConnected = false;
  signaling.on('welcome', async (msg) => {
    $('my-id').textContent = formatId(msg.id);
    if (msg.id !== state.config.deviceId || msg.token) {
      state.config = { ...state.config, ...(await rc.saveConfig({ deviceId: msg.id, deviceToken: msg.token ?? state.config.deviceToken })) };
    }
    rc.log(`online as ${msg.id}`);

    const cli = state.config.cli;
    if (cli.connect && !autoConnected) {
      autoConnected = true;
      connectTo(cli.connect, cli.password);
    }
  });

  signaling.on('disconnected', () => {
    // The server ends every session of a device that drops, so mirror that locally.
    state.host?.end('server-offline', { remote: true });
    state.viewer?.end('server-offline', { remote: true });
    closeIncoming();
    if (state.outgoing) {
      state.outgoing = null;
      closeViewer();
      toast(reasonText('server-offline'), 'error');
    }
  });

  signaling.on('incoming', onIncoming);
  signaling.on('session', onOutgoingSession);
  signaling.on('connect-error', (msg) => {
    if (msg.ref !== state.outgoing?.ref) return;
    state.outgoing = null;
    closeViewer();
    toast(reasonText(msg.reason), 'error');
  });
  signaling.on('accepted', (msg) => {
    if (msg.sessionId !== state.viewer?.id) return;
    $('viewer-overlay-text').textContent = 'Connecting…';
    state.viewer.start(msg.iceServers);
  });
  signaling.on('signal', (msg) => {
    const session = [state.host, state.viewer].find((s) => s?.id === msg.sessionId);
    session?.onSignal(msg.data);
  });
  signaling.on('ended', (msg) => {
    if (state.incoming?.sessionId === msg.sessionId) closeIncoming();
    const session = [state.host, state.viewer].find((s) => s?.id === msg.sessionId);
    session?.end(msg.reason, { remote: true });
  });
}

function renderStatus(s) {
  const el = $('status');
  el.dataset.state = s;
  el.querySelector('span').textContent = { online: 'Ready', connecting: 'Connecting…', offline: 'Offline' }[s];
  el.title = state.config.serverUrl;
  $('btn-connect').disabled = s !== 'online';
}

// ---------------------------------------------------------------- hosting

function onIncoming(msg) {
  const reject = (reason) => signaling.send({ type: 'reject', sessionId: msg.sessionId, reason });

  if (state.host || state.incoming) return reject('busy');

  if (msg.password) {
    const now = Date.now();
    state.failedPasswords = state.failedPasswords.filter((t) => now - t < LOCKOUT_MS);
    if (state.failedPasswords.length >= MAX_FAILED_PASSWORDS) return reject('locked');
    if (safeEqual(msg.password, state.password)) return acceptIncoming(msg);
    state.failedPasswords.push(now);
    rc.log(`wrong password from ${msg.from.id}`);
    return reject('wrong-password');
  }

  promptIncoming(msg);
}

function promptIncoming(msg) {
  state.incoming = msg;
  $('incoming-text').textContent = `${formatId(msg.from.id)} wants to connect to this device.`;
  $('incoming-meta').textContent = [msg.from.name, msg.from.platform].filter(Boolean).join(' · ');

  let remaining = PROMPT_TIMEOUT_S;
  const tick = () => ($('incoming-countdown').textContent = `(${remaining})`);
  tick();
  msg.timer = setInterval(() => {
    remaining -= 1;
    tick();
    if (remaining <= 0) decideIncoming(false);
  }, 1000);

  $('incoming-modal').showModal();
  rc.attention();
}

function decideIncoming(accept) {
  const msg = state.incoming;
  if (!msg) return;
  closeIncoming();
  if (accept) acceptIncoming(msg);
  else signaling.send({ type: 'reject', sessionId: msg.sessionId, reason: 'rejected' });
}

function closeIncoming() {
  if (!state.incoming) return;
  clearInterval(state.incoming.timer);
  state.incoming = null;
  $('incoming-modal').close();
}

async function acceptIncoming(msg) {
  signaling.send({ type: 'accept', sessionId: msg.sessionId });

  const session = new HostSession({
    sessionId: msg.sessionId,
    peer: msg.from,
    signaling,
    iceServers: msg.iceServers,
    device: { name: state.config.deviceName, platform: state.config.platform },
    allowControl: $('allow-control').checked,
  });
  state.host = session;
  rc.log(`hosting session ${session.id} for ${msg.from.id}`);

  $('host-banner-text').textContent = `${formatId(msg.from.id)} is connecting…`;
  $('host-banner').hidden = false;
  rc.attention();

  session.on('connected', () => {
    $('host-banner-text').textContent = `Your screen is shared with ${formatId(msg.from.id)}${msg.from.name ? ` (${msg.from.name})` : ''}`;
    rc.log(`host session ${session.id} connected`);
  });
  session.on('ended', (reason, { remote }) => {
    if (state.host === session) state.host = null;
    $('host-banner').hidden = true;
    rc.log(`host session ${session.id} ended: ${reason}`);
    toast(remote && reason !== 'ended' ? `Session ended: ${reasonText(reason)}` : 'Session ended.');
  });

  try {
    await session.start();
  } catch (err) {
    console.error('could not start sharing:', err);
    session.end('capture-failed');
  }
}

// ---------------------------------------------------------------- viewing

function connectTo(rawId, password = '') {
  const targetId = String(rawId).replace(/\D/g, '');
  if (state.viewer || state.outgoing) return toast('Close the current session first.', 'error');
  if (signaling.state !== 'online') return toast('Not connected to the server.', 'error');

  const ref = crypto.randomUUID();
  state.outgoing = { ref, targetId };
  openViewer(targetId, password ? 'Checking password…' : 'Waiting for the remote side to accept…');
  signaling.send({ type: 'connect', targetId, password, ref });
}

function onOutgoingSession(msg) {
  if (msg.ref !== state.outgoing?.ref) {
    // We cancelled before the server answered.
    signaling.send({ type: 'end', sessionId: msg.sessionId, reason: 'cancelled' });
    return;
  }
  state.outgoing = null;

  const session = new ViewerSession({
    sessionId: msg.sessionId,
    targetId: msg.targetId,
    signaling,
    video: $('remote-video'),
    stage: $('viewer-stage'),
  });
  state.viewer = session;
  let remoteName = '';

  session.on('remote-info', ({ name, platform }) => {
    remoteName = name;
    $('viewer-title').textContent = `${formatId(msg.targetId)} · ${name}`;
    $('viewer-title').title = platform;
  });
  session.on('first-frame', () => {
    $('viewer-overlay').hidden = true;
    $('viewer-stage').focus();
    rc.log(`viewer session ${session.id} receiving video`);
    addRecent(msg.targetId, remoteName);
  });
  session.on('screens', ({ list, current }) => {
    const select = $('viewer-screen');
    select.replaceChildren(
      ...list.map((s) => new Option(`${s.name}${s.primary ? ' (main)' : ''}`, s.id, false, s.id === current)),
    );
    select.hidden = list.length < 2;
  });
  session.on('control', (allowed) => {
    $('viewer-viewonly').disabled = !allowed;
    if (!allowed) toast('The remote side disabled control. View only.');
  });
  session.on('stats', renderStats);
  session.on('ended', (reason, { remote }) => {
    if (state.viewer === session) state.viewer = null;
    closeViewer();
    rc.log(`viewer session ${session.id} ended: ${reason}`);
    if (remote) toast(reasonText(reason), reason === 'ended' ? 'info' : 'error');
  });
}

function openViewer(targetId, text) {
  $('viewer-title').textContent = formatId(targetId);
  $('viewer-badge').hidden = true;
  $('viewer-stats').textContent = '';
  $('viewer-screen').hidden = true;
  $('viewer-viewonly').setAttribute('aria-pressed', 'false');
  $('viewer-viewonly').disabled = false;
  $('viewer-overlay-text').textContent = text;
  $('viewer-overlay').hidden = false;
  $('viewer').hidden = false;
}

function closeViewer() {
  $('viewer').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen();
  rc.setFullScreen(false);
}

function renderStats(s) {
  if (s.relayed != null) {
    const badge = $('viewer-badge');
    badge.hidden = false;
    badge.dataset.kind = s.relayed ? 'relay' : 'direct';
    badge.textContent = s.relayed ? 'Relayed' : 'Direct P2P';
    badge.title = s.relayed ? 'Traffic goes through the TURN relay server' : 'Peer-to-peer connection';
  }
  const parts = [];
  if (s.width) parts.push(`${s.width}×${s.height}`);
  if (s.fps != null) parts.push(`${Math.round(s.fps)} fps`);
  if (s.kbps != null) parts.push(s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbps` : `${s.kbps} kbps`);
  if (s.rttMs != null) parts.push(`${s.rttMs} ms`);
  $('viewer-stats').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- updates

let dismissedUpdate = null;

async function bindUpdates() {
  rc.updates.onState(renderUpdate);
  renderUpdate(await rc.updates.getState());

  $('update-install').addEventListener('click', () => {
    if ((state.host || state.viewer) && !confirm('Updating restarts the app and ends the current session. Continue?')) return;
    rc.updates.install();
  });
  $('update-later').addEventListener('click', async () => {
    dismissedUpdate = (await rc.updates.getState()).release?.version ?? null;
    $('update-banner').hidden = true;
  });
  $('update-check').addEventListener('click', async () => {
    dismissedUpdate = null;
    const result = await rc.updates.check();
    if (result.status === 'up-to-date') toast(`You're up to date (version ${result.current}).`, 'ok');
  });
}

function renderUpdate(s) {
  const version = s.release?.version;
  const banner = $('update-banner');
  const busy = s.status === 'downloading' || s.status === 'installing';
  banner.dataset.status = s.status;
  banner.hidden = !(busy || (version && version !== dismissedUpdate && (s.status === 'available' || s.status === 'error')));

  const percent = s.progress?.percent;
  $('update-text').textContent =
    {
      available: `Remote Connection ${version} is available.`,
      downloading: `Downloading version ${version}…${percent != null ? ` ${percent}%` : ''}`,
      installing: `Installing version ${version}. The app will restart in a moment…`,
      error: s.error,
    }[s.status] ?? '';
  $('update-progress').hidden = s.status !== 'downloading';
  $('update-progress').firstElementChild.style.width = `${percent ?? 0}%`;
  $('update-install').hidden = busy;
  $('update-later').hidden = busy;
  $('update-install').textContent = s.status === 'error' ? 'Retry' : s.canInstall ? 'Install & restart' : 'Download';

  $('update-status').textContent =
    {
      checking: 'Checking for updates…',
      'up-to-date': "You're up to date.",
      available: `Version ${version} is available.`,
      downloading: `Downloading version ${version}…`,
      installing: `Installing version ${version}…`,
      error: s.error,
    }[s.status] ?? 'Updates are checked automatically.';
  $('update-check').disabled = s.status === 'checking' || busy;
}

// ---------------------------------------------------------------- UI wiring

function bindUi() {
  $('remote-id').addEventListener('input', (e) => {
    e.target.value = formatId(e.target.value.replace(/\D/g, '').slice(0, 9));
  });

  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('remote-id').value.replace(/\D/g, '');
    if (id.length !== 9) return toast(reasonText('invalid-id'), 'error');
    connectTo(id, $('remote-password').value);
    $('remote-password').value = '';
  });

  $('regen-password').addEventListener('click', () => {
    state.password = randomPassword();
    state.failedPasswords = [];
    $('my-password').textContent = state.password;
    toast('New password generated.', 'ok');
  });

  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy === 'my-password' ? state.password : $(btn.dataset.copy).textContent.replace(/\s/g, '');
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.', 'ok');
    });
  }

  $('incoming-accept').addEventListener('click', () => decideIncoming(true));
  $('incoming-reject').addEventListener('click', () => decideIncoming(false));
  $('incoming-modal').addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc must not silently dismiss the request
    decideIncoming(false);
  });

  $('allow-control').addEventListener('change', (e) => state.host?.setAllowControl(e.target.checked));
  $('host-disconnect').addEventListener('click', () => state.host?.end('ended'));

  $('viewer-disconnect').addEventListener('click', () => state.viewer?.end('ended'));
  $('viewer-cancel').addEventListener('click', () => {
    if (state.viewer) state.viewer.end('cancelled');
    else {
      state.outgoing = null;
      closeViewer();
    }
  });
  $('viewer-viewonly').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    state.viewer?.setViewOnly(on);
  });
  $('viewer-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('viewer').requestFullscreen();
  });
  $('viewer-screen').addEventListener('change', (e) => {
    state.viewer?.selectScreen(e.target.value);
    $('viewer-stage').focus();
  });
  // Toolbar clicks shouldn't steal keyboard focus from the remote session.
  for (const btn of document.querySelectorAll('.viewer-toolbar button')) {
    btn.addEventListener('mouseup', () => $('viewer-stage').focus());
  }

  $('btn-settings').addEventListener('click', () => {
    $('set-server').value = state.config.serverUrl;
    $('set-name').value = state.config.deviceName;
    $('settings-modal').showModal();
  });
  $('settings-cancel').addEventListener('click', () => $('settings-modal').close());
  $('settings-form').addEventListener('submit', async (e) => {
    const serverUrl = $('set-server').value.trim();
    const deviceName = $('set-name').value.trim();
    if (!/^wss?:\/\/.+/.test(serverUrl)) {
      e.preventDefault();
      return toast('Server URL must start with ws:// or wss://', 'error');
    }
    const serverChanged = serverUrl !== state.config.serverUrl;
    const nameChanged = deviceName !== state.config.deviceName;
    // A different server means a different ID registry.
    const patch = serverChanged ? { serverUrl, deviceName, deviceId: null, deviceToken: null } : { deviceName };
    state.config = { ...state.config, ...(await rc.saveConfig(patch)) };
    if (serverChanged) $('my-id').textContent = '— — —';
    if (serverChanged || nameChanged) signaling.setUrl(state.config.serverUrl);
  });
}

function renderRecent() {
  const list = $('recent');
  const recent = state.config.recent ?? [];
  $('recent-empty').hidden = recent.length > 0;
  list.replaceChildren(
    ...recent.map((r) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const id = document.createElement('span');
      const name = document.createElement('span');
      id.className = 'rid';
      id.textContent = formatId(r.id);
      name.className = 'muted';
      name.textContent = r.name ?? '';
      btn.append(id, name);
      btn.addEventListener('click', () => {
        $('remote-id').value = formatId(r.id);
        $('remote-password').focus();
      });
      li.append(btn);
      return li;
    }),
  );
}

async function addRecent(id, name) {
  const recent = [{ id, name, at: Date.now() }, ...(state.config.recent ?? []).filter((r) => r.id !== id)].slice(0, MAX_RECENT);
  state.config = { ...state.config, ...(await rc.saveConfig({ recent })) };
  renderRecent();
}

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}
