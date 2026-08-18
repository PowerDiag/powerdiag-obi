/*
 * Web Serial transport for the PowerDiag OBI interface board.
 *
 * Frame format, mirroring the firmware in ArduinoOBI/src/main.cpp:
 *
 *   request   [0x01] [data_len] [rsp_len] [cmd] [data ...]
 *   response  [cmd]  [rsp_len]  [payload ...]        (rsp_len + 2 bytes total)
 *
 * The firmware raises ENABLE and waits 400 ms before touching the 1-Wire bus,
 * so every exchange takes noticeably longer than the byte time suggests.
 */

const BAUD_RATE = 9600;
const RESPONSE_TIMEOUT_MS = 2000;
const DEFAULT_ATTEMPTS = 2;

/* Opening the port toggles DTR, and on a Nano that line is coupled to RESET,
 * so the board can reboot as we connect. Rather than making every connection
 * wait out the worst case, we settle the control lines briefly and let the
 * version probe retry through the boot window. */
const SIGNAL_SETTLE_MS = 250;

/* CH340 (QinHeng) and the other USB-serial bridges found on Nano boards, so the
 * browser's port picker only offers the interface board and not every COM port
 * on the machine. */
export const PORT_FILTERS = [
  { usbVendorId: 0x1a86 }, // CH340 / CH341 / CH343
  { usbVendorId: 0x0403 }, // FTDI FT232
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x2341 }, // Arduino
  { usbVendorId: 0x1b4f }, // SparkFun
  { usbVendorId: 0x303a }, // Espressif (ESP32-C3 build)
];

export class ObiError extends Error {
  constructor(messageKey, detail) {
    super(detail ? `${messageKey}: ${detail}` : messageKey);
    this.messageKey = messageKey;
    this.detail = detail;
  }
}

export class Transport extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
    this.readLoopDone = null;
  }

  get isOpen() {
    return this.port !== null;
  }

  log(direction, bytes) {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    this.dispatchEvent(new CustomEvent('log', { detail: { direction, hex } }));
  }

  /** Ports this origin has already been granted access to, for silent reconnect. */
  static async knownPorts() {
    if (!('serial' in navigator)) return [];
    try {
      return await navigator.serial.getPorts();
    } catch {
      return [];
    }
  }

  static async requestPort() {
    return navigator.serial.requestPort({ filters: PORT_FILTERS });
  }

  async open(port) {
    await port.open({ baudRate: BAUD_RATE });
    this.port = port;
    this.buffer = new Uint8Array(0);
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.readLoopDone = this.readLoop();

    /* Drive the control lines explicitly rather than inheriting whatever the
     * platform left them at, then wait out the reset described above. */
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch {
      /* Not every platform exposes the control lines; the wait still helps. */
    }
    await new Promise((resolve) => setTimeout(resolve, SIGNAL_SETTLE_MS));
    this.buffer = new Uint8Array(0); // discard any bootloader chatter

    this.dispatchEvent(new Event('open'));
  }

  async readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.append(value);
      }
    } catch {
      /* Port went away mid-read: surfaced by close() below. */
    }
    this.dispatchEvent(new Event('disconnect'));
  }

  append(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  async close() {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { this.reader?.releaseLock(); } catch { /* already released */ }
    try { await this.readLoopDone; } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await port.close(); } catch { /* already closed */ }
    this.reader = this.writer = null;
    this.dispatchEvent(new Event('close'));
  }

  /** Wait until `count` bytes have arrived, then consume them from the buffer. */
  async take(count, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (this.buffer.length < count) {
      if (performance.now() > deadline) {
        throw new ObiError('err.timeout', `${this.buffer.length}/${count} bytes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!this.port) throw new ObiError('err.disconnected');
    }
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return out;
  }

  /**
   * Send one command frame and return its payload (the bytes after the
   * two-byte response header). Commands declaring a zero-length response get
   * their two header bytes drained and return null.
   */
  async request(frame, { attempts = DEFAULT_ATTEMPTS, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    if (!this.port) throw new ObiError('err.notConnected');

    const rspLen = frame[2];
    const expected = rspLen + 2;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.buffer = new Uint8Array(0); // discard anything left from an earlier exchange
        this.log('tx', frame.slice(3));
        await this.writer.write(new Uint8Array(frame));

        const response = await this.take(expected, timeoutMs);
        const payload = response.slice(2);
        this.log('rx', payload);

        const cmd = frame[3];
        if (response[0] !== cmd || response[1] !== rspLen) {
          throw new ObiError(
            'err.mismatch',
            `header ${response[0].toString(16)} ${response[1].toString(16)}, expected ${cmd.toString(16)} ${rspLen.toString(16)}`,
          );
        }

        if (rspLen === 0) return null;

        /* An all-0xFF payload means the bus floated: no battery, or bad contact. */
        if (payload.every((b) => b === 0xff)) throw new ObiError('err.allFF');

        return payload;
      } catch (error) {
        lastError = error;
        if (!this.port) break;
      }
    }
    throw lastError ?? new ObiError('err.noResponse');
  }
}
