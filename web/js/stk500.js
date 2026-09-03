/*
 * STK500v1 over Web Serial — flashing an Arduino Nano's bootloader from the
 * browser, so a freshly soldered kit needs no toolchain to come alive.
 *
 * Written from the protocol itself (Atmel AVR061) rather than ported from an
 * existing flasher: the exchange is a handful of commands and every one of
 * them answers inside the same 0x14 ... 0x10 envelope.
 *
 *   sync           30 20                      -> 14 10
 *   enter progmode 50 20                      -> 14 10
 *   load address   55 <lo> <hi> 20            -> 14 10      (WORD address)
 *   program page   64 <hi> <lo> 46 <data> 20  -> 14 10
 *   read page      74 <hi> <lo> 46 20         -> 14 <data> 10
 *   leave progmode 51 20                      -> 14 10
 *
 * Nothing here can brick a board. The bootloader sits in a protected section
 * and never rewrites itself, so a failed or abandoned flash leaves it intact
 * and the next attempt starts from exactly the same place.
 */

import { ObiError } from './transport.js';

const SYNC = 0x30;
const ENTER_PROGMODE = 0x50;
const LEAVE_PROGMODE = 0x51;
const LOAD_ADDRESS = 0x55;
const PROG_PAGE = 0x64;
const READ_PAGE = 0x74;
const CRC_EOP = 0x20;
const RESP_INSYNC = 0x14;
const RESP_OK = 0x10;
const MEM_FLASH = 0x46; // 'F'

/** ATmega328P flash page, in bytes. */
const PAGE_SIZE = 128;

/*
 * Nano clones ship one of two bootloaders and there is no way to ask which:
 * the newer Optiboot listens at 115200, the older ATmegaBOOT at 57600, and a
 * mismatch looks exactly like a board that is not there. So try both.
 */
const BAUD_RATES = [115200, 57600];

/* The auto-reset circuit is a capacitor between DTR and RESET, so what resets
 * the board is the edge, not the level. Drop both control lines, let the line
 * settle, then assert: that edge starts the bootloader. */
const RESET_LOW_MS = 250;
const RESET_SETTLE_MS = 50;

/* Optiboot gives up and jumps to the application after about a second, so the
 * sync attempts have to land inside that window rather than be spread politely
 * across it. */
const SYNC_ATTEMPTS = 6;
const SYNC_TIMEOUT_MS = 300;
const REPLY_TIMEOUT_MS = 2000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an Intel HEX file into a flat image.
 *
 * Gaps between records are filled with 0xFF — an erased flash cell — so a
 * sparse file still writes whole pages without carrying anything stale.
 */
export function parseIntelHex(text) {
  const sparse = [];
  let base = 0;
  let seenEof = false;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || seenEof) continue;

    const where = `line ${index + 1}`;
    if (line[0] !== ':') throw new ObiError('err.hexFormat', where);
    if (line.length < 11 || line.length % 2 === 0) throw new ObiError('err.hexFormat', where);

    const bytes = [];
    for (let i = 1; i + 1 < line.length; i += 2) {
      const byte = Number.parseInt(line.slice(i, i + 2), 16);
      if (Number.isNaN(byte)) throw new ObiError('err.hexFormat', where);
      bytes.push(byte);
    }

    /* Every record carries a two's-complement checksum, so a truncated or
     * corrupted download is caught here and not halfway through a write. */
    const sum = bytes.reduce((acc, b) => (acc + b) & 0xff, 0);
    if (sum !== 0) throw new ObiError('err.hexChecksum', where);

    const length = bytes[0];
    const address = base + (bytes[1] << 8) + bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + length);
    if (data.length !== length) throw new ObiError('err.hexFormat', where);

    if (type === 0x00) {
      for (let i = 0; i < length; i += 1) sparse[address + i] = data[i];
    } else if (type === 0x01) {
      seenEof = true;
    } else if (type === 0x02) {
      base = ((data[0] << 8) + data[1]) << 4;
    } else if (type === 0x04) {
      base = ((data[0] << 8) + data[1]) << 16;
    }
    /* Types 03 and 05 carry a start address, which the bootloader decides for
     * itself; ignoring them is correct rather than merely convenient. */
  }

  if (!seenEof) throw new ObiError('err.hexFormat', 'no end-of-file record');
  if (!sparse.length) throw new ObiError('err.hexFormat', 'no data');

  const image = new Uint8Array(sparse.length);
  image.fill(0xff);
  for (let i = 0; i < sparse.length; i += 1) {
    if (sparse[i] !== undefined) image[i] = sparse[i];
  }
  return image;
}

class Programmer {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
    this.readLoopDone = null;
  }

  async open(baudRate) {
    await this.port.open({ baudRate });
    this.buffer = new Uint8Array(0);
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readLoopDone = this.readLoop();
  }

  async readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          const merged = new Uint8Array(this.buffer.length + value.length);
          merged.set(this.buffer, 0);
          merged.set(value, this.buffer.length);
          this.buffer = merged;
        }
      }
    } catch {
      /* The port went away; the pending take() reports it. */
    }
  }

  async close() {
    try {
      await this.reader?.cancel();
      await this.readLoopDone;
      this.reader?.releaseLock();
    } catch { /* already gone */ }
    try {
      this.writer?.releaseLock();
    } catch { /* a write was still in flight */ }
    this.reader = this.writer = null;
    try {
      await this.port.close();
    } catch { /* nothing left to do about it */ }
  }

  /** Pulse RESET through the DTR capacitor and hand control to the bootloader. */
  async reset() {
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await delay(RESET_LOW_MS);
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await delay(RESET_SETTLE_MS);
    this.buffer = new Uint8Array(0); // drop whatever the reset shook loose
  }

  async take(count, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (this.buffer.length < count) {
      if (performance.now() > deadline) {
        throw new ObiError('err.flashTimeout', `${this.buffer.length}/${count} bytes`);
      }
      await delay(5);
    }
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return out;
  }

  /**
   * Send a command and check the INSYNC/OK envelope around its reply.
   * `expect` is the number of payload bytes carried between the two.
   */
  async command(bytes, { expect = 0, timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    this.buffer = new Uint8Array(0);
    await this.writer.write(new Uint8Array(bytes));

    const reply = await this.take(expect + 2, timeoutMs);
    if (reply[0] !== RESP_INSYNC || reply[reply.length - 1] !== RESP_OK) {
      const head = reply[0].toString(16);
      const tail = reply[reply.length - 1].toString(16);
      throw new ObiError('err.flashProtocol', `${head}..${tail}`);
    }
    return reply.slice(1, 1 + expect);
  }

  /** Get in step with the bootloader, or report that nothing answered. */
  async sync() {
    let lastError = null;
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
      try {
        await this.command([SYNC, CRC_EOP], { timeoutMs: SYNC_TIMEOUT_MS });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new ObiError('err.flashNoSync');
  }

  /** STK500 addresses flash in words, so the byte address is halved. */
  async loadAddress(byteAddress) {
    const word = byteAddress >> 1;
    await this.command([LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff, CRC_EOP]);
  }

  async writePage(byteAddress, page) {
    await this.loadAddress(byteAddress);
    const frame = [PROG_PAGE, (page.length >> 8) & 0xff, page.length & 0xff, MEM_FLASH];
    for (let i = 0; i < page.length; i += 1) frame.push(page[i]);
    frame.push(CRC_EOP);
    await this.command(frame);
  }

  async readPage(byteAddress, length) {
    await this.loadAddress(byteAddress);
    const frame = [READ_PAGE, (length >> 8) & 0xff, length & 0xff, MEM_FLASH, CRC_EOP];
    return this.command(frame, { expect: length });
  }
}

/**
 * Write an Intel HEX image to a Nano and read it back to prove it landed.
 *
 * The port must not already be open: this takes it at the bootloader's baud
 * rate, which is not the one the application runs at.
 *
 * @param port       A SerialPort from navigator.serial.
 * @param image      Flat flash image, from parseIntelHex().
 * @param onProgress Called with ('write'|'verify', done, total) as it runs.
 * @returns The baud rate that worked, so the caller can say which it was.
 */
export async function flash(port, image, onProgress = () => {}) {
  let lastError = null;

  for (const baudRate of BAUD_RATES) {
    const programmer = new Programmer(port);
    try {
      await programmer.open(baudRate);
      await programmer.reset();
      await programmer.sync();
      await programmer.command([ENTER_PROGMODE, CRC_EOP]);

      const pages = Math.ceil(image.length / PAGE_SIZE);

      for (let i = 0; i < pages; i += 1) {
        const start = i * PAGE_SIZE;
        const page = image.slice(start, Math.min(start + PAGE_SIZE, image.length));
        await programmer.writePage(start, page);
        onProgress('write', i + 1, pages);
      }

      /* Read back rather than trusting the acknowledgements: a marginal USB
       * cable acknowledges everything and still writes rubbish. */
      for (let i = 0; i < pages; i += 1) {
        const start = i * PAGE_SIZE;
        const expected = image.slice(start, Math.min(start + PAGE_SIZE, image.length));
        const actual = await programmer.readPage(start, expected.length);
        for (let b = 0; b < expected.length; b += 1) {
          if (actual[b] !== expected[b]) {
            throw new ObiError('err.flashVerify', `0x${(start + b).toString(16)}`);
          }
        }
        onProgress('verify', i + 1, pages);
      }

      await programmer.command([LEAVE_PROGMODE, CRC_EOP]);
      await programmer.close();
      return baudRate;
    } catch (error) {
      lastError = error;
      await programmer.close();

      /* Only a failure to get in step is worth trying the other baud rate for.
       * Once the bootloader has answered, a later error is a real one and
       * retrying at the wrong speed would bury it. */
      const key = error && error.messageKey;
      if (key !== 'err.flashTimeout' && key !== 'err.flashProtocol') throw error;
    }
  }

  throw lastError || new ObiError('err.flashNoSync');
}
