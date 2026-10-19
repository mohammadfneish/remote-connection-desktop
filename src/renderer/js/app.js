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
  system: { startAtLogin: { supported: false, enabled: false }, closeToTray: true, unattendedEnabled: false, twofaEnabled: false, trusted: [] },
  addressBook: [],
  pendingConnect: null, // { targetId, password } kept for a 2FA retry
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
  state.system = await rc.system.get();
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
  bindSharing();
  bindAddressBook();
  bindTotpModal();
  refreshAddressBook();
  // "Disconnect session" from the tray ends the connection someone has to this computer.
  rc.onHostDisconnect(() => state.host?.end('ended'));

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

async function onIncoming(msg) {
  const reject = (reason) => signaling.send({ type: 'reject', sessionId: msg.sessionId, reason });

  if (state.host || state.incoming) return reject('busy');

  // Read the current unattended/trusted settings from the main process (authoritative).
  state.system = await rc.system.get();

  if (msg.password) {
    const now = Date.now();
    state.failedPasswords = state.failedPasswords.filter((t) => now - t < LOCKOUT_MS);
    if (state.failedPasswords.length >= MAX_FAILED_PASSWORDS) return reject('locked');

    // The one-time session password (shown on this screen) is an attended path — accept it
    // directly, no second factor.
    if (safeEqual(msg.password, state.password)) return acceptIncoming(msg);

    // The unattended password (and its two-factor code, if enabled) is checked in main.
    const result = await rc.unattended.check(msg.password, msg.code);
    if (result.ok) return acceptIncoming(msg);
    if (result.needCode && !result.badCode) return reject('totp-required'); // password ok, code needed
    state.failedPasswords.push(now);
    rc.log(`failed unattended attempt from ${msg.from.id}${result.badCode ? ' (wrong code)' : ''}`);
    return reject(result.badCode ? 'wrong-code' : 'wrong-password');
  }

  // A device the local user previously chose to "always allow" skips the prompt. The host
  // still sees the banner and gets a notification, and can disconnect any time.
  if (state.system.trusted.some((d) => d.id === msg.from.id)) return acceptIncoming(msg);

  promptIncoming(msg);
}

function promptIncoming(msg) {
  state.incoming = msg;
  $('incoming-text').textContent = `${formatId(msg.from.id)} wants to connect to this device.`;
  $('incoming-meta').textContent = [msg.from.name, msg.from.platform].filter(Boolean).join(' · ');
  $('incoming-trust').checked = false;

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
  if (accept) msg.trustDevice = $('incoming-trust').checked;
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
  attachShare(session, $('host-clipboard').checked);
  rc.log(`hosting session ${session.id} for ${msg.from.id}`);

  $('host-banner-text').textContent = `${formatId(msg.from.id)} is connecting…`;
  $('host-banner').hidden = false;
  rc.attention();

  const peerLabel = `${formatId(msg.from.id)}${msg.from.name ? ` (${msg.from.name})` : ''}`;
  session.on('connected', () => {
    $('host-banner-text').textContent = `Your screen is shared with ${peerLabel}`;
    // Make the session visible to whoever is at this computer: tray, window, notification.
    rc.hosting(true, peerLabel);
    rc.log(`host session ${session.id} connected`);
  });
  session.on('ended', (reason, { remote }) => {
    if (state.host === session) state.host = null;
    rc.hosting(false);
    updateClipboardWatch();
    $('host-banner').hidden = true;
    rc.log(`host session ${session.id} ended: ${reason}`);
    toast(remote && reason !== 'ended' ? `Session ended: ${reasonText(reason)}` : 'Session ended.');
  });

  // The local user ticked "always allow this device" on the prompt.
  if (msg.trustDevice) rc.trusted.add({ id: msg.from.id, name: msg.from.name }).then((s) => (state.system = s));

  try {
    await session.start();
  } catch (err) {
    console.error('could not start sharing:', err);
    session.end('capture-failed');
  }
}

// ---------------------------------------------------------------- viewing

function connectTo(rawId, password = '', code = '') {
  const targetId = String(rawId).replace(/\D/g, '');
  if (state.viewer || state.outgoing) return toast('Close the current session first.', 'error');
  if (signaling.state !== 'online') return toast('Not connected to the server.', 'error');

  const ref = crypto.randomUUID();
  // Remembered so we can resend with a 2FA code if the remote device asks for one.
  state.pendingConnect = { targetId, password };
  state.outgoing = { ref, targetId };
  openViewer(targetId, code ? 'Checking code…' : password ? 'Checking password…' : 'Waiting for the remote side to accept…');
  signaling.send({ type: 'connect', targetId, password, code, ref });
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
  attachShare(session, $('viewer-clipboard').getAttribute('aria-pressed') === 'true');
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
    updateClipboardWatch();
    closeViewer();
    rc.log(`viewer session ${session.id} ended: ${reason}`);
    // The remote device wants a 2FA code (or the one we sent was wrong): ask and retry.
    if (remote && (reason === 'totp-required' || reason === 'wrong-code')) {
      return promptTotp(reason === 'wrong-code');
    }
    if (remote) toast(reasonText(reason), reason === 'ended' ? 'info' : 'error');
  });
}

/** Ask for the authenticator code, then reconnect to the pending device with it. */
function promptTotp(wasWrong = false) {
  const pending = state.pendingConnect;
  if (!pending) return;
  $('totp-error').textContent = wasWrong ? 'That code was not accepted. Try the current one.' : '';
  $('totp-error').hidden = !wasWrong;
  $('totp-input').value = '';
  $('totp-modal').showModal();
  setTimeout(() => $('totp-input').focus(), 50);
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

// ---------------------------------------------------------------- clipboard & files

const transferViews = new Map(); // transfer key -> { el, share }
let pickerTarget = null;

function attachShare(session, clipboardOn) {
  session.share.setClipboardEnabled(clipboardOn);
  session.share.on('transfer', (t) => renderTransfer(t, session.share));
  session.share.on('clipboard-received', (kind) => rc.log(`clipboard: received ${kind} from ${formatId(session.peerId)}`));
  updateClipboardWatch();
}

/** The clipboard is only watched while a session exists. */
function updateClipboardWatch() {
  rc.clipboard.watch(Boolean(state.host || state.viewer));
}

function bindSharing() {
  rc.clipboard.onChange((item) => {
    state.host?.share.localClipboard(item);
    state.viewer?.share.localClipboard(item);
  });

  $('host-clipboard').addEventListener('change', (e) => state.host?.share.setClipboardEnabled(e.target.checked));
  $('viewer-clipboard').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    state.viewer?.share.setClipboardEnabled(on);
    toast(on ? 'Clipboard sharing is on.' : 'Clipboard sharing is off.');
  });

  $('host-send-files').addEventListener('click', () => pickFiles(state.host));
  $('viewer-send-files').addEventListener('click', () => pickFiles(state.viewer));
  $('file-picker').addEventListener('change', (e) => {
    sendFiles(pickerTarget, [...e.target.files]);
    e.target.value = '';
  });

  // Drag & drop: onto the remote screen while viewing, anywhere on the window while hosting.
  const viewing = () => !$('viewer').hidden && state.viewer;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  document.addEventListener('dragover', (e) => {
    e.preventDefault(); // never let Electron open a dropped file
    if (!hasFiles(e)) return;
    e.dataTransfer.dropEffect = viewing() || state.host ? 'copy' : 'none';
    $('drop-overlay').hidden = !viewing();
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) $('drop-overlay').hidden = true;
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $('drop-overlay').hidden = true;
    if (!hasFiles(e)) return;
    const target = viewing() || state.host;
    if (!target) return toast('Connect to a device to send files.', 'error');

    const files = [];
    let folders = 0;
    for (const item of e.dataTransfer.items) {
      if (item.kind !== 'file') continue;
      if (item.webkitGetAsEntry?.()?.isDirectory) folders += 1;
      else files.push(item.getAsFile());
    }
    if (folders) toast('Folders can’t be sent yet. Send the files inside, or zip the folder first.', 'error');
    sendFiles(target, files.filter(Boolean));
  });
}

function pickFiles(session) {
  if (!session?.share.filesReady) return toast('The connection isn’t ready yet.', 'error');
  pickerTarget = session;
  $('file-picker').click();
}

function sendFiles(session, files) {
  if (!files.length) return;
  if (!session || session.ended || !session.share.sendFiles(files)) toast('The connection isn’t ready yet.', 'error');
}

const formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const ARROW = {
  out: '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>',
  in: '<svg viewBox="0 0 24 24"><path d="M12 5v14m0 0-6-6m6 6 6-6" /></svg>',
};

function renderTransfer(t, share) {
  let view = transferViews.get(t.key);
  if (!view) {
    const el = document.createElement('div');
    el.className = 'transfer';
    el.innerHTML = `
      <div class="transfer-head">${ARROW[t.direction]}<span class="transfer-name"></span>
        <button class="icon-btn" title="Cancel" aria-label="Cancel transfer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
      </div>
      <div class="progress"><i></i></div>
      <div class="transfer-meta"><span class="transfer-status"></span><span class="transfer-action"></span></div>`;
    el.querySelector('.transfer-name').textContent = t.name;
    el.querySelector('.transfer-name').title = t.name;
    el.querySelector('.icon-btn').addEventListener('click', () => {
      if (el.dataset.status === 'active') share.cancelTransfer(t.key);
      else removeTransfer(t.key);
    });
    $('transfers').append(el);
    view = { el, share };
    transferViews.set(t.key, view);
  }

  const { el } = view;
  el.dataset.status = t.status;
  const percent = t.size ? Math.round((t.done / t.size) * 100) : t.status === 'done' ? 100 : 0;
  el.querySelector('.progress i').style.width = `${percent}%`;
  el.querySelector('.icon-btn').title = t.status === 'active' ? 'Cancel' : 'Dismiss';

  const verb = t.direction === 'out' ? 'Sending' : 'Receiving';
  el.querySelector('.transfer-status').textContent =
    {
      active: `${verb} · ${formatBytes(t.done)} of ${formatBytes(t.size)}`,
      done: t.direction === 'out' ? `Sent · ${formatBytes(t.size)}` : 'Saved to Downloads › Remote Connection',
      cancelled: 'Cancelled',
      failed: t.message || 'Failed',
    }[t.status] ?? '';

  const action = el.querySelector('.transfer-action');
  action.replaceChildren();
  if (t.status === 'done' && t.canReveal) {
    const reveal = document.createElement('button');
    reveal.textContent = 'Show in folder';
    reveal.addEventListener('click', () => rc.files.reveal(t.id));
    action.append(reveal);
  }

  if (t.status !== 'active') {
    clearTimeout(view.timer);
    view.timer = setTimeout(() => removeTransfer(t.key), t.canReveal ? 30_000 : 8_000);
  }
}

function removeTransfer(key) {
  const view = transferViews.get(key);
  if (!view) return;
  clearTimeout(view.timer);
  view.el.remove();
  transferViews.delete(key);
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
    renderSystemSettings();
    $('settings-modal').showModal();
  });
  $('settings-cancel').addEventListener('click', () => $('settings-modal').close());
  bindSystemSettings();
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

// ---------------------------------------------------------------- unattended access, startup & tray

function renderSystemSettings() {
  const s = state.system;
  $('row-start-login').hidden = !s.startAtLogin.supported;
  $('set-start-login').checked = s.startAtLogin.enabled;
  $('set-close-tray').checked = s.closeToTray;

  $('unattended-off').hidden = s.unattendedEnabled;
  $('unattended-on').hidden = !s.unattendedEnabled;
  $('set-unattended').value = '';

  // Two-factor: only offered once an unattended password exists.
  $('twofa-block').hidden = !s.unattendedEnabled;
  $('twofa-setup').hidden = true;
  $('twofa-toggle').textContent = s.twofaEnabled ? 'Turn off' : 'Enable';
  $('twofa-desc').textContent = s.twofaEnabled
    ? '● On — unattended connections require a code from your authenticator app.'
    : 'Require a code from your authenticator app for unattended connections.';

  $('trusted-section').hidden = s.trusted.length === 0;
  $('trusted-list').replaceChildren(
    ...s.trusted.map((d) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.innerHTML = `<span class="tdev-id">${formatId(d.id)}</span>${d.name ? ` · ${escapeText(d.name)}` : ''}`;
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        state.system = await rc.trusted.remove(d.id);
        renderSystemSettings();
      });
      li.append(label, remove);
      return li;
    }),
  );
}

function bindSystemSettings() {
  $('set-start-login').addEventListener('change', async (e) => {
    state.system = await rc.system.setStartAtLogin(e.target.checked);
    renderSystemSettings();
  });
  $('set-close-tray').addEventListener('change', async (e) => {
    state.system = await rc.system.setCloseToTray(e.target.checked);
  });

  const saveUnattended = async () => {
    const value = $('set-unattended').value;
    const result = await rc.unattended.set(value);
    if (result.error) return toast(result.error, 'error');
    state.system = result;
    renderSystemSettings();
    toast('Unattended access is on. Keep this password private.', 'ok');
  };
  $('unattended-save').addEventListener('click', saveUnattended);
  $('set-unattended').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), saveUnattended()));

  $('unattended-change').addEventListener('click', () => {
    state.system = { ...state.system, unattendedEnabled: false };
    renderSystemSettings();
  });
  $('unattended-disable').addEventListener('click', async () => {
    state.system = await rc.unattended.disable();
    renderSystemSettings();
    toast('Unattended access is off.');
  });

  // ---- two-factor
  $('twofa-toggle').addEventListener('click', async () => {
    if (state.system.twofaEnabled) {
      state.system = await rc.twofa.disable();
      renderSystemSettings();
      toast('Two-factor authentication turned off.');
      return;
    }
    const res = await rc.twofa.begin();
    if (res.error) return toast(res.error, 'error');
    $('twofa-qr').src = res.qr;
    $('twofa-secret').textContent = res.secret.replace(/(.{4})/g, '$1 ').trim();
    $('twofa-code').value = '';
    $('twofa-setup-error').hidden = true;
    $('twofa-setup').hidden = false;
    setTimeout(() => $('twofa-code').focus(), 50);
  });
  const confirmTwofa = async () => {
    const res = await rc.twofa.enable($('twofa-code').value.replace(/\D/g, ''));
    if (res.error) {
      $('twofa-setup-error').textContent = res.error;
      $('twofa-setup-error').hidden = false;
      return;
    }
    state.system = res;
    renderSystemSettings();
    toast('Two-factor authentication is on.', 'ok');
  };
  $('twofa-confirm').addEventListener('click', confirmTwofa);
  $('twofa-code').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), confirmTwofa()));
  $('twofa-cancel').addEventListener('click', () => ($('twofa-setup').hidden = true));
}

const escapeText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- address book

async function refreshAddressBook() {
  state.addressBook = await rc.addressBook.get();
  renderAddressBook();
}

function renderAddressBook() {
  const list = $('addressbook');
  const book = state.addressBook ?? [];
  $('addressbook-empty').hidden = book.length > 0;
  list.replaceChildren(
    ...book.map((d) => {
      const li = document.createElement('li');
      li.className = 'addr-item';

      const connect = document.createElement('button');
      connect.className = 'addr-connect';
      connect.title = 'Connect';
      const name = document.createElement('span');
      name.className = 'addr-name';
      name.textContent = d.name;
      const sub = document.createElement('span');
      sub.className = 'addr-sub';
      sub.textContent = `${formatId(d.id)}${d.hasPassword ? ' · saved password' : ''}`;
      connect.append(name, sub);
      connect.addEventListener('click', async () => {
        const password = d.hasPassword ? await rc.addressBook.password(d.id) : '';
        connectTo(d.id, password);
      });

      const edit = document.createElement('button');
      edit.className = 'addr-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openAddrModal(d));

      const remove = document.createElement('button');
      remove.className = 'addr-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        state.addressBook = await rc.addressBook.remove(d.id);
        renderAddressBook();
      });

      li.append(connect, edit, remove);
      return li;
    }),
  );
}

function openAddrModal(entry = null) {
  $('addr-title').textContent = entry ? 'Edit device' : 'Add device';
  $('addr-name').value = entry?.name ?? '';
  $('addr-id').value = entry ? formatId(entry.id) : $('remote-id').value;
  $('addr-id').disabled = Boolean(entry); // id is the key; change by removing + re-adding
  $('addr-password').value = '';
  $('addr-password').placeholder = entry?.hasPassword ? 'Saved — leave blank to keep' : 'Saved for one-click connect';
  $('addr-error').hidden = true;
  $('addr-modal').showModal();
}

function bindAddressBook() {
  $('addr-add').addEventListener('click', () => openAddrModal());
  $('addr-id').addEventListener('input', (e) => (e.target.value = formatId(e.target.value.replace(/\D/g, '').slice(0, 9))));
  $('addr-cancel').addEventListener('click', () => $('addr-modal').close());
  $('addr-form').addEventListener('submit', async (e) => {
    const id = $('addr-id').value.replace(/\D/g, '');
    const entry = { id, name: $('addr-name').value.trim(), password: $('addr-password').value };
    const res = await rc.addressBook.save(entry);
    if (res.error) {
      e.preventDefault();
      $('addr-error').textContent = res.error;
      $('addr-error').hidden = false;
      return;
    }
    state.addressBook = res;
    renderAddressBook();
  });
}

function bindTotpModal() {
  $('totp-cancel').addEventListener('click', () => {
    $('totp-modal').close();
    state.pendingConnect = null;
  });
  $('totp-form').addEventListener('submit', (e) => {
    const code = $('totp-input').value.replace(/\D/g, '');
    if (code.length !== 6) {
      e.preventDefault();
      $('totp-error').textContent = 'Enter the 6-digit code.';
      $('totp-error').hidden = false;
      return;
    }
    const pending = state.pendingConnect;
    if (pending) connectTo(pending.targetId, pending.password, code);
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
