/*
 * Relay transport for the PowerDiag OBI web app.
 *
 * A drop-in alternative to Transport (transport.js): same request()/open()/
 * close()/isOpen and the same 'log' / 'open' / 'close' / 'disconnect' events,
 * so lxt.js and app.js drive it without knowing the board is not on this USB
 * port but on someone else's, reached over the /com relay.
 *
 * Where Transport writes a frame to a local serial port and reads the reply
 * back, this sends the same bytes to the sharer's browser as one relayed
 * exchange — "write these bytes, read exactly this many back" — and gets the
 * reply. The frame format and every check on the reply are identical to the
 * local transport; only the wire underneath is different.
 *
 *   const t = new RelayTransport();
 *   await t.open({ room: 'OBI', pin: '4821' });   // channel name + PIN
 *   const payload = await t.request(frame);        // exactly as with Transport
 *
 * Not wired into the connect screen yet: this is the transport on its own.
 */

import { ObiError } from './transport.js';

/* A relay hop puts a human's laptop and the public internet between the write
 * and the reply, so the wait is longer than the local 2000 ms, and a lost
 * round trip is retried rather than failed on. */
const RESPONSE_TIMEOUT_MS = 6000;
const DEFAULT_ATTEMPTS = 3;

/* How long to wait, after the relay accepts us, for the sharer's port to be
 * present. They are meant to be sharing already; this only covers the moment
 * between joining and the presence message arriving. */
const PEER_WAIT_MS = 8000;

function relayUrl() {
  /* Same origin as the app in production (nginx maps /com-relay/ onto the
   * relay service); a local dev build talks to the service directly. */
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local) return 'ws://127.0.0.1:8788/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/com-relay/ws`;
}

const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const fromHex = (text) =>
  text ? text.trim().split(/\s+/).map((token) => Number.parseInt(token, 16)) : [];

/*
 * The operator half of the relay, as much of it as reading a pack needs:
 * connect to a named channel, learn whether the sharer's port is up, and run
 * id-correlated request/response exchanges. Ported from the /com page's
 * relay.js, trimmed to what a read needs (no baud change, no control lines).
 */
class RelayClient extends EventTarget {
  constructor(base) {
    super();
    this.base = base;
    this.ws = null;
    this.peerUp = false;
    this.pending = new Map();
    this.nextId = 1;
    this.closedByUs = false;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Join a named channel as the operator. Resolves on the relay's hello. */
  connect({ room, pin, token }) {
    this.closedByUs = false;
    const url = new URL(this.base);
    url.searchParams.set('role', 'operator');
    if (room) url.searchParams.set('room', room);
    if (pin) url.searchParams.set('pin', pin);
    if (token) url.searchParams.set('token', token);

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.t === 'hello') {
          settled = true;
          resolve(msg);
          return;
        }
        if (msg.t === 'peer') {
          this.peerUp = msg.up;
          /* A sharer going away strands every request in flight; fail them now
           * rather than let each wait out its whole timeout. */
          if (!msg.up) this.failAll('the shared port went away');
          this.dispatchEvent(new CustomEvent('peer', { detail: msg }));
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.t === 'err') entry.reject(new Error(msg.message || msg.code || 'device error'));
          else entry.resolve(msg);
        }
      });

      ws.addEventListener('close', (event) => {
        this.failAll('disconnected');
        this.peerUp = false;
        if (!settled) reject(new ObiError('err.relayClosed', closeReason(event.code)));
        this.dispatchEvent(new CustomEvent('closed', {
          detail: { code: event.code, byUs: this.closedByUs },
        }));
      });
    });
  }

  failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Send a message and wait for the reply carrying the same id. */
  request(obj, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ObiError('err.timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (!this.isOpen) throw new ObiError('err.notConnected');
        this.ws.send(JSON.stringify({ ...obj, id }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  disconnect() {
    this.closedByUs = true;
    this.ws?.close(1000, 'bye');
  }
}

export class RelayTransport extends EventTarget {
  constructor() {
    super();
    this.relay = null;
    /* Transport exposes `port`; app.js compares against it in the USB
     * disconnect handler. There is no local port here, so it stays null and
     * that handler simply never matches. */
    this.port = null;
  }

  get isOpen() {
    return this.relay?.isOpen ?? false;
  }

  log(direction, bytes) {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    this.dispatchEvent(new CustomEvent('log', { detail: { direction, hex } }));
  }

  /**
   * Join a shared channel and wait for the sharer's port to be present.
   * @param {{room: string, pin?: string, token?: string}} params
   */
  async open({ room, pin, token } = {}) {
    /* A missing room is a caller bug, not a situation the user can be in, so it
     * carries no translated key — it should never reach the screen. */
    if (!room) throw new Error('relay transport: open() needs a channel name');

    const relay = new RelayClient(relayUrl());
    /* A dropped relay while connected surfaces the same way a USB unplug does,
     * so app.js's disconnect handling needs no relay-specific branch. */
    relay.addEventListener('closed', () => {
      if (this.relay === relay) this.dispatchEvent(new Event('disconnect'));
    });
    relay.addEventListener('peer', (event) => {
      if (this.relay === relay && !event.detail.up) this.dispatchEvent(new Event('disconnect'));
    });

    await relay.connect({ room, pin, token });
    this.relay = relay;

    if (!relay.peerUp) {
      try {
        await waitFor(relay, 'peer', (detail) => detail.up, PEER_WAIT_MS);
      } catch {
        relay.disconnect();
        this.relay = null;
        throw new ObiError('err.relayNoDevice');
      }
    }

    this.dispatchEvent(new Event('open'));
  }

  /** Test seam: one relayed exchange, returning the reply bytes. */
  async _xfer(frameBytes, read, timeoutMs) {
    const reply = await this.relay.request(
      { t: 'xfer', hex: toHex(frameBytes), read, timeout: timeoutMs },
      /* The sharer's own timeout has to expire first, or a slow pack looks to
       * us like a dead relay. */
      timeoutMs + 8000,
    );
    return { bytes: fromHex(reply.hex), timedOut: Boolean(reply.timedOut) };
  }

  /**
   * Send one command frame and return its payload (the bytes after the
   * two-byte response header), or null for a zero-length response. Frame
   * format and every check below are identical to the local Transport, so a
   * caller cannot tell which transport answered.
   */
  async request(frame, { attempts = DEFAULT_ATTEMPTS, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    if (!this.isOpen) throw new ObiError('err.notConnected');

    const rspLen = frame[2];
    const expected = rspLen + 2;
    const cmd = frame[3];
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.log('tx', frame.slice(3));
        /* Exact-length read: the sharer returns as soon as `expected` bytes
         * arrive, so a busy pack does not hold the exchange open for the whole
         * timeout — the failure mode that turned a remote write into a gateway
         * timeout once. */
        const { bytes: response, timedOut } = await this._xfer(frame, expected, timeoutMs);

        if (timedOut || response.length < expected) {
          throw new ObiError('err.timeout', `${response.length}/${expected} bytes`);
        }

        const payload = response.slice(2, expected);
        this.log('rx', payload);

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
        if (!this.isOpen) break;
      }
    }
    throw lastError ?? new ObiError('err.noResponse');
  }

  async close() {
    if (!this.relay) return;
    const relay = this.relay;
    this.relay = null;
    relay.disconnect();
    this.dispatchEvent(new Event('close'));
  }
}

/* Resolve on the next matching event, or reject after ms. Used to wait out the
 * gap between joining a channel and the sharer's presence arriving. */
function waitFor(target, type, predicate, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, handler);
      reject(new Error('timed out'));
    }, ms);
    function handler(event) {
      if (!predicate(event.detail)) return;
      clearTimeout(timer);
      target.removeEventListener(type, handler);
      resolve(event.detail);
    }
    target.addEventListener(type, handler);
  });
}

function closeReason(code) {
  switch (code) {
    case 4404: return 'no channel by that name';
    case 4403: return 'wrong PIN for that channel';
    case 4409: return 'joined from somewhere else';
    case 4429: return 'the relay is at capacity';
    default:   return `connection closed (${code})`;
  }
}
