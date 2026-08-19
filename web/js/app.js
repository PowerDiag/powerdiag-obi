import { Transport, ObiError } from './transport.js';
import { LxtBattery } from './lxt.js';
import { i18n } from './i18n.js';
import { VERSION } from './version.js';

const transport = new Transport();
const battery = new LxtBattery(transport);

const el = (id) => document.getElementById(id);
const t = (key) => i18n.t(key);

/* Field order on screen. `key` is the i18n key, `id` the slot to fill. */
const IDENTITY_FIELDS = [
  ['field.model', 'model'],
  ['field.state', 'state'],
  ['field.statusCode', 'statusCode'],
  ['field.chargeCount', 'chargeCount'],
  ['field.capacity', 'capacity'],
  ['field.batteryType', 'batteryType'],
  ['field.manufactured', 'manufactured'],
  ['field.romId', 'romId'],
];

const VOLTAGE_FIELDS = [
  ['field.cellDiff', 'cellDiff'],
  ['field.tempCell', 'tempCell'],
  ['field.tempMosfet', 'tempMosfet'],
];

let busy = false;

/* Someone without the board can otherwise only look at a button that does
 * nothing. These are the readings taken off a real BL1860B, not invented
 * numbers, so what a visitor sees is what the tool actually shows. */
let demo = false;

const DEMO = {
  identity: {
    model: 'BL1860B', locked: false, statusCode: '67', chargeCount: 25,
    capacityAh: 6.0, batteryType: 18, manufactured: '25/07/2021',
    romId: '15 07 19 64 14 08 01 6C',
    message: 'F1 26 BD 13 14 58 00 00 94 94 40 21 D0 80 02 1E C3 D0 8E 67 60 F7 00 21 02 02 0E 91 00 51 01 33',
  },
  cells: {
    packVoltage: 18.512, cells: [3.706, 3.706, 3.708, 3.708, 3.707],
    cellDiff: 0.002, tempCell: 30.18, tempMosfet: 30.31,
  },
  terminal: 18.47,
};

/* The last reading, kept so a language switch can redraw the screen instead
 * of throwing away values that are still perfectly good. */
const reading = { identity: null, cells: null, terminal: null };

/* Each in its own language: someone looking for their language cannot read
 * the name of it written in another. */
const LANG_NAMES = {
  ja: '日本語',
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ko: '한국어',
  vi: 'Tiếng Việt',
  th: 'ไทย',
};

/* ---------- rendering ---------- */

function fieldRow(labelKey, slot) {
  return `<div class="row"><dt data-i18n="${labelKey}">${t(labelKey)}</dt><dd id="v-${slot}" class="empty">—</dd></div>`;
}

function buildLayout() {
  el('identity-fields').innerHTML = IDENTITY_FIELDS.map(([k, s]) => fieldRow(k, s)).join('');
  el('voltage-fields').innerHTML = VOLTAGE_FIELDS.map(([k, s]) => fieldRow(k, s)).join('');
  el('cell-fields').innerHTML = '';
  el('cell-tiles').innerHTML = [1, 2, 3, 4, 5]
    .map(
      (n) => `<div class="tile" id="tile-${n}">
        <span class="tile-label"><span data-i18n="field.cell">${t('field.cell')}</span> ${n}</span>
        <span class="tile-value" id="v-cell${n}">—</span>
      </div>`,
    )
    .join('');
}

/* Thresholds a technician acts on: below 3.3 V the cell is lagging, below
 * 3.0 V it is the reason the pack is on the bench. */
const CELL_LOW = 3.3;
const CELL_CRITICAL = 3.0;

function markCell(index, volts) {
  const tile = el(`tile-${index}`);
  if (!tile) return;
  tile.className = `tile${volts < CELL_CRITICAL ? ' crit' : volts < CELL_LOW ? ' warn' : ''}`;
}

function set(slot, value) {
  const node = el(`v-${slot}`);
  if (!node) return;
  const empty = value === null || value === undefined || value === '';
  node.textContent = empty ? '—' : value;
  /* Chipped lists frame their values; an unread row should not be framed. */
  node.classList.toggle('empty', empty);
}

function clearValues() {
  reading.identity = reading.cells = reading.terminal = null;
  document.querySelectorAll('#panels dd, .tile-value').forEach((node) => {
    node.textContent = '—';
    node.classList.add('empty');
  });
  document.querySelectorAll('.tile').forEach((node) => { node.className = 'tile'; });
  el('readout-voltage').textContent = '—';
  el('readout-terminal').textContent = '—';
  el('state-badge').className = 'badge hidden';
  el('note-limited').classList.add('hidden');
}

function applyLanguage() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.title = `${t('app.title')} — ${t('app.subtitle')}`;
  el('btn-log').textContent = el('log').classList.contains('hidden') ? t('log.show') : t('log.hide');
}

/* The key travels with the element. Re-rendering for a language change reads
 * data-i18n back off the node, so a status left with the key it was born with
 * would announce "not connected" over a live connection. */
function status(key, tone = 'info') {
  document.querySelectorAll('.status').forEach((node) => {
    node.dataset.i18n = key;
    node.textContent = t(key);
    node.className = `status ${tone === 'info' ? '' : tone}`.trim();
  });
}

function fail(error) {
  const key = error instanceof ObiError ? error.messageKey : null;
  const text = key ? t(key) : String(error.message || error);
  document.querySelectorAll('.status').forEach((node) => {
    /* A message we have no key for cannot be re-rendered in another language,
     * so drop the attribute rather than let it fall back to a stale one. */
    if (key) node.dataset.i18n = key;
    else delete node.dataset.i18n;
    node.textContent = text;
    node.className = 'status error';
  });
  log('err', text);
}

const logLines = [];

function log(kind, text) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const marker = kind === 'tx' ? '>>' : kind === 'rx' ? '<<' : '!!';
  const entry = `${stamp} ${marker} ${text}`;
  logLines.push(entry);

  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  line.textContent = entry;
  const box = el('log');
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  logLines.length = 0;
  el('log').replaceChildren();
}

/* Hand the traffic to support as a file rather than asking for a screenshot. */
function exportLog() {
  if (!logLines.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([logLines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `powerdiag-obi-${stamp}.log`;
  link.click();
  URL.revokeObjectURL(url);
}

transport.addEventListener('log', (event) => log(event.detail.direction, event.detail.hex));

/* ---------- connection ---------- */

function setConnected(connected) {
  el('landing').classList.toggle('hidden', connected);
  el('dashboard').classList.toggle('hidden', !connected);
  /* Port and disconnect live in the always-visible app bar, so they have to be
   * hidden explicitly rather than disappearing with the dashboard. */
  el('conn-info').classList.toggle('hidden', !connected);
  el('btn-disconnect').classList.toggle('hidden', !connected);
  document.querySelectorAll('.needs-connection').forEach((node) => { node.disabled = !connected; });
}

/* Web Serial deliberately withholds the OS port name, so the closest thing to
 * "which port" we can show the user is the USB identity behind it. */
const USB_CHIPS = {
  0x1a86: 'CH340', 0x0403: 'FTDI', 0x10c4: 'CP210x',
  0x2341: 'Arduino', 0x1b4f: 'SparkFun', 0x303a: 'ESP32',
};

function describePort(port) {
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo?.() ?? {};
  if (vid === undefined) return 'USB';
  const id = `${vid.toString(16).padStart(4, '0').toUpperCase()}:${(pid ?? 0).toString(16).padStart(4, '0').toUpperCase()}`;
  return USB_CHIPS[vid] ? `${USB_CHIPS[vid]} · ${id}` : id;
}

async function connect(port) {
  status('status.connecting');
  await transport.open(port);

  /* Past this point the port is open, so every failure has to close it again.
   * A port left open reports "already open" on the next attempt, with the UI
   * insisting nothing is connected. */
  try {
    battery.reset();

    /* Any CH340 on the machine shows up in the picker, so identify the board
     * before letting the user drive it. The version command answers on every
     * OBI firmware; silence means this is some other serial device, and saying
     * so beats letting every later command time out mysteriously. */
    const version = await battery.interfaceVersion({ attempts: 5 });

    setConnected(true);
    el('port-name').textContent = `${describePort(port)} · FW ${version}`;
    status('status.connected', 'ok');
  } catch (error) {
    await transport.close();
    setConnected(false);
    throw error instanceof ObiError && error.messageKey !== 'err.timeout'
      ? error
      : new ObiError('err.notObi');
  }
}

async function onConnectClick() {
  /* The port picker is the user's time, not ours. A bar sliding away while
   * they read a list of devices says the tool is working when it is only
   * waiting to be told which one. */
  showBusy(false);
  try {
    const port = await Transport.requestPort();
    showBusy(true);
    await connect(port);
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      status('err.noPort', 'error');
      el('driver-hint').classList.remove('hidden');
      return;
    }
    fail(error);
  }
}

transport.addEventListener('close', () => {
  setConnected(false);
  clearValues();
  status('status.idle');
});

transport.addEventListener('disconnect', () => {
  if (transport.isOpen) transport.close();
});

function enterDemo() {
  demo = true;
  setConnected(true);
  el('port-name').textContent = t('demo.label');
  el('conn-info').querySelector('.dot').className = 'dot warn';

  reading.identity = { ...DEMO.identity };
  reading.cells = { ...DEMO.cells };
  reading.terminal = DEMO.terminal;
  renderIdentity();
  renderCells();
  renderTerminal();

  /* Nothing to write to, so the actions that would write are off rather than
   * pretending. */
  document.querySelectorAll('.needs-hardware').forEach((n) => { n.disabled = true; });
  status('demo.status', 'warn');
}

function exitDemo() {
  demo = false;
  el('conn-info').querySelector('.dot').className = 'dot on';
  setConnected(false);
  clearValues();
  status('status.idle');
}

/* ---------- actions ---------- */

function showBusy(on) {
  el('busy').classList.toggle('hidden', !on);
}

async function guard(action) {
  if (busy) return;
  busy = true;
  showBusy(true);
  document.querySelectorAll('.needs-connection').forEach((n) => { n.disabled = true; });
  try {
    await action();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    showBusy(false);
    document.querySelectorAll('.needs-connection').forEach((n) => { n.disabled = !transport.isOpen; });
  }
}

async function showTerminalVoltage() {
  reading.terminal = await battery.terminalVoltage();
  renderTerminal();
}

function renderTerminal() {
  const volts = reading.terminal;
  el('readout-terminal').textContent =
    volts === null || volts === undefined ? '—' : `${volts.toFixed(2)} V`;
}

function showCells(data) {
  reading.cells = data;
  renderCells();
}

function renderCells() {
  const data = reading.cells;
  if (!data) return;
  el('readout-voltage').textContent = `${data.packVoltage.toFixed(2)} V`;
  data.cells.forEach((v, i) => {
    set(`cell${i + 1}`, `${v.toFixed(3)} V`);
    markCell(i + 1, v);
  });
  set('cellDiff', `${data.cellDiff.toFixed(3)} V`);
  set('tempCell', `${data.tempCell.toFixed(2)} °C`);
  set('tempMosfet', data.tempMosfet === null ? null : `${data.tempMosfet.toFixed(2)} °C`);
}

/* What the identity card shows: who this pack is and what state it is in. */
async function readIdentity() {
  status('status.reading');
  if (demo) { renderIdentity(); status('demo.status', 'warn'); return; }

  const info = await battery.readStatic();

  /* Reading the model also settles which dialect the pack speaks, which the
   * cell read depends on. */
  const { model, limited } = await battery.readModel();

  reading.identity = { ...info, model, limited };
  renderIdentity();

  status('status.done', 'ok');
}

function renderIdentity() {
  const info = reading.identity;
  if (!info) return;

  set('model', info.model);
  set('chargeCount', info.chargeCount);
  set('statusCode', info.statusCode);
  set('capacity', `${info.capacityAh.toFixed(1)} Ah`);
  set('batteryType', info.batteryType);
  set('manufactured', info.manufactured);
  set('romId', info.romId);
  set('message', info.message);

  const badge = el('state-badge');
  badge.textContent = t(info.locked ? 'state.locked' : 'state.unlocked');
  badge.className = `badge ${info.locked ? 'danger' : 'ok'}`;
  set('state', badge.textContent);

  el('note-limited').classList.toggle('hidden', !info.limited);
}

/* What the voltages card shows. */
async function readCells() {
  status('status.reading');
  if (demo) { renderCells(); renderTerminal(); status('demo.status', 'warn'); return; }
  await showTerminalVoltage();
  showCells(await battery.readCells());
  status('status.done', 'ok');
}

/* The one button most customers ever press: both cards, in the order that
 * lets the model settle the dialect before the cells are read. */
async function readAll() {
  if (demo) { enterDemo(); return; }
  clearValues();
  await readIdentity();
  await readCells();
}

/* The browser's confirm() announces itself as the browser's, cannot be styled
 * and blocks the whole page; the native dialog carries the tool's own frame
 * while the browser still handles the focus trap and Esc. */
function askConfirm(messageKey) {
  const dialog = el('confirm');
  el('confirm-text').textContent = t(messageKey);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

async function clearErrors() {
  if (!(await askConfirm('confirm.clear'))) return;
  status('status.reading');
  await battery.clearErrors();
  status('status.cleared', 'ok');
  await readAll(); // show what the pack reports now
}

/* Copy what is on screen as text. A reading pasted into a support message is
 * searchable and quotable; a screenshot of the same reading is neither. */
async function copyReadings() {
  const lines = [];

  const push = (label, value) => {
    const text = (value || '').trim();
    if (label && text && text !== '—') lines.push(label + '\t' + text);
  };

  push(t('field.packVoltage'), el('readout-voltage').textContent);
  push(t('field.terminalVoltage'), el('readout-terminal').textContent);

  document.querySelectorAll('#panels .tile').forEach((tile) => {
    push(tile.querySelector('.tile-label')?.textContent?.trim(),
         tile.querySelector('.tile-value')?.textContent);
  });

  document.querySelectorAll('#panels .fields .row').forEach((row) => {
    push(row.querySelector('dt')?.textContent?.trim(),
         row.querySelector('dd')?.textContent);
  });

  push(t('field.message'), el('v-message').textContent);

  if (!lines.length) return;
  await navigator.clipboard.writeText(lines.join('\n') + '\n');
  status('status.copied', 'ok');
}

/* Installing turns the page into a windowed app with its own icon, still
 * running on the browser already on the machine. Chromium hands us the prompt
 * rather than letting us raise one, so the button only appears once it has,
 * and goes away once the app is installed. */
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installed = false;   // it is only offered when the app is not there
  refreshInstallState();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installed = true;
  refreshInstallState();
});

/* Three states, and the third can only be inferred: a browser that can install
 * offers the prompt shortly after load, so silence past that means this one
 * cannot. Saying so beats a button that would do nothing, or no answer at all
 * to a customer wondering where the app went. */
const INSTALL_VERDICT_MS = 1500;
let installVerdictDue = false;

function refreshInstallState() {
  const offered = installPrompt !== null;

  el('btn-installed').classList.toggle('hidden', !installed);
  el('btn-install').classList.toggle('hidden', installed || !offered);
  el('install-unsupported').classList
    .toggle('hidden', installed || offered || !installVerdictDue);
}

async function install() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  /* The prompt is single-use whichever way it was answered. */
  installPrompt = null;
  refreshInstallState();
}

/* No API removes an installed app — a page that could uninstall itself could
 * uninstall anything — so the most we can do is say where the control lives,
 * and only while the app is actually running installed. */
let installed = false;

/* True only while the page is being viewed inside the installed window. */
function isStandalone() {
  return ['standalone', 'window-controls-overlay', 'minimal-ui']
    .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

/* Installed and then opened in an ordinary tab looks exactly like a browser
 * that cannot install at all: not standalone, and no prompt offered, because
 * the prompt is withheld once the app exists. Only the manifest can settle
 * it, and only if it names itself as a related application. */
async function detectInstalled() {
  if (isStandalone()) return true;
  if (!navigator.getInstalledRelatedApps) return false;
  try {
    const apps = await navigator.getInstalledRelatedApps();
    return apps.some((app) => app.platform === 'webapp');
  } catch {
    return false;
  }
}

function showUninstallHelp() {
  el('uninstall-url').textContent =
    navigator.userAgent.includes('Edg/') ? 'edge://apps' : 'chrome://apps';
  el('uninstall').showModal();
}

/* ---------- wiring ---------- */

function guardUnsupported() {
  if (!window.isSecureContext) {
    el('unsupported').textContent = t('err.insecure');
    el('unsupported').classList.remove('hidden');
    return true;
  }
  if (!('serial' in navigator)) {
    el('unsupported').textContent = t('err.unsupported');
    el('unsupported').classList.remove('hidden');
    return true;
  }
  return false;
}

async function init() {
  document.documentElement.lang = i18n.lang;

  /* Which build the customer is actually running: the first thing to
   * establish before believing any bug report. */
  el('build').textContent = `${VERSION.date} · ${VERSION.commit}`;

  buildLayout();
  applyLanguage();

  const langSelect = el('lang');
  langSelect.innerHTML = i18n.languages
    .map((code) => `<option value="${code}">${LANG_NAMES[code] ?? code}</option>`)
    .join('');
  langSelect.value = i18n.lang;
  langSelect.addEventListener('change', () => {
    i18n.set(langSelect.value);
    buildLayout();    // labels like "Cell 1" are assembled, so they are rebuilt
    applyLanguage();
    renderIdentity(); // and the reading is redrawn, not discarded
    renderCells();
    renderTerminal();
  });

  el('btn-log').addEventListener('click', () => {
    el('log').classList.toggle('hidden');
    applyLanguage();
  });
  el('btn-log-clear').addEventListener('click', clearLog);
  el('btn-log-export').addEventListener('click', exportLog);

  if (guardUnsupported()) {
    el('btn-connect').disabled = true;
    return;
  }

  el('btn-connect').addEventListener('click', () => guard(onConnectClick));
  el('btn-demo').addEventListener('click', enterDemo);
  el('btn-install').addEventListener('click', install);
  el('btn-installed').addEventListener('click', showUninstallHelp);

  installed = await detectInstalled();
  refreshInstallState();
  setTimeout(async () => {
    /* Ask once more before saying it cannot be installed: the answer may have
     * arrived late, and that verdict is the one worth being sure about. */
    if (!installed) installed = await detectInstalled();
    installVerdictDue = true;
    refreshInstallState();
  }, INSTALL_VERDICT_MS);
  el('btn-disconnect').addEventListener('click', () => {
    if (demo) exitDemo();
    else transport.close();
  });
  el('btn-read').addEventListener('click', () => guard(readAll));
  el('btn-cells').addEventListener('click', () => guard(readCells));
  el('btn-identity').addEventListener('click', () => guard(readIdentity));
  el('btn-clear').addEventListener('click', () => guard(clearErrors));
  el('btn-copy').addEventListener('click', () => guard(copyReadings));
  el('btn-leds-on').addEventListener('click', () => guard(() => battery.ledsOn()));
  el('btn-leds-off').addEventListener('click', () => guard(() => battery.ledsOff()));

  navigator.serial.addEventListener('disconnect', (event) => {
    if (transport.port === event.target) transport.close();
  });

  /* Hand the port back when the page goes away. The OS releases it when the
   * process exits anyway, but a reload or a closed tab is not a process exit,
   * and the next window would find the device claimed. */
  window.addEventListener('pagehide', () => { transport.close(); });

  setConnected(false);
  status('status.idle');

  /* No reconnect on load. Silently reclaiming a port made disconnect
   * meaningless — a refresh put you straight back — and left it unclear which
   * device the tool had picked. Connecting is a deliberate act, with the
   * picker every time. */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }
}

init();
