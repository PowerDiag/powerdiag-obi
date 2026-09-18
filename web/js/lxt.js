/*
 * Makita LXT protocol, ported field-for-field from the reference implementation
 * in OpenBatteryInformation/modules/makita_lxt.py.
 *
 * Offsets differ from the Python by two: there `response` still carries the
 * two-byte response header, here the transport has already stripped it, so
 * every `response[n]` below became `payload[n - 2]`.
 */

import { ObiError } from './transport.js';

const CMD = {
  INTERFACE_VERSION: [0x01, 0x00, 0x03, 0x01],
  INTERFACE_VOLTAGE: [0x01, 0x00, 0x02, 0x02],

  MODEL:        [0x01, 0x02, 0x10, 0xcc, 0xdc, 0x0c],
  READ_DATA:    [0x01, 0x04, 0x1d, 0xcc, 0xd7, 0x00, 0x00, 0xff],
  READ_MSG:     [0x01, 0x02, 0x28, 0x33, 0xaa, 0x00],
  TESTMODE:     [0x01, 0x03, 0x09, 0x33, 0xd9, 0x96, 0xa5],
  LEDS_ON:      [0x01, 0x02, 0x09, 0x33, 0xda, 0x31],
  LEDS_OFF:     [0x01, 0x02, 0x09, 0x33, 0xda, 0x34],
  RESET_ERROR:  [0x01, 0x02, 0x09, 0x33, 0xda, 0x04],
  CLEAR:        [0x01, 0x02, 0x00, 0xcc, 0xf0, 0x00],

  /* Older F0513 packs speak a different, much more limited dialect. */
  F0513_MODEL:    [0x01, 0x00, 0x02, 0x31],
  F0513_TESTMODE: [0x01, 0x01, 0x00, 0xcc, 0x99],
  F0513_TEMP:     [0x01, 0x01, 0x02, 0xcc, 0x52],
  F0513_VCELL:    [1, 2, 3, 4, 5].map((n) => [0x01, 0x01, 0x02, 0xcc, 0x30 + n]),
  /* PowerDiag firmware only. Reads all five cell registers atomically inside a
   * single powered session — the only way F0513 cells come out. Five u16 LE. */
  F0513_CELLS:    [0x01, 0x00, 0x0a, 0x36],
};

/* Two firmwares answer on this board and both are supported.
 *
 * Stock ArduinoOBI (upstream, 0.x.x — 0.2.1 is what ships) is a serial bridge:
 * commands 0x31, 0x33 and 0xCC, nothing else. PowerDiag's firmware numbers
 * itself 9.x.x precisely so it can be told apart, and adds 0x02 (pack voltage
 * off the R10/R11 divider) and 0x36 (atomic F0513 cell read).
 *
 * Which one is in front of us decides which read path runs. Stock gets the
 * stock path and behaves exactly as upstream does — no extra commands sent at
 * it, and nothing said about its firmware: a board doing what it was built to
 * do is not a fault. */
const isPowerDiagFw = (version) => Number(String(version ?? '').split('.')[0]) >= 9;

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const u16le = (payload, offset) => payload[offset] | (payload[offset + 1] << 8);

const nibbleSwap = (byte) => ((byte & 0xf0) >> 4) | ((byte & 0x0f) << 4);

/* How many cells in series, from the flags byte of the basic frame. Taken from
 * the D1L firmware, which notes this is steadier than reading the model name —
 * the name comes from a command a faulty pack often refuses, while this byte
 * arrives with the frame we already have. Verified against a real BL1860B:
 * byte 25 is 0xD0, which swaps to 0x0D. */
const CELLS_BY_FLAG = { 0x0a: 4, 0x0d: 5, 0x0e: 5, 0x1e: 10 };

/* A lithium cell cannot exceed about 4.5 V, so neither can the pack. Anything
 * above that is a corrupt read — a stuck bit turns 0x0E into 0x4E and a cell
 * reads twenty volts. Deliberately no lower bound: a dead cell really does
 * report 0 mV, and that is the reading a repair shop came for. */
const CELL_CEILING = 4.5;

export class LxtBattery {
  constructor(transport) {
    this.transport = transport;
    this.dialect = null;      // null until a model read succeeds, then '' or 'F0513'
    this.voltageSupported = null; // null = not probed, false = board has no divider
    this.cellCount = 5;       // until the pack says otherwise
    this.fwVersion = null;    // null until interfaceVersion() succeeds
  }

  reset() {
    this.dialect = null;
    this.voltageSupported = null;
    this.cellCount = 5;
    this.fwVersion = null;
  }

  /** Firmware version of the interface board itself, e.g. "9.0.0" for
   * PowerDiag's firmware or "0.2.1" for stock. Cached on the instance, since
   * it is what picks the read path for everything below. */
  async interfaceVersion({ attempts = 5 } = {}) {
    const payload = await this.transport.request(CMD.INTERFACE_VERSION, { attempts });
    this.fwVersion = Array.from(payload).join('.');
    return this.fwVersion;
  }

  /**
   * Pack voltage measured by the board on the battery terminals, in volts.
   * PowerDiag firmware and the R10/R11 divider only; stock firmware has no such
   * command, so it is not asked — a timeout per read would be the only result.
   * A PowerDiag build on a board without the divider fails the probe once and
   * is then not asked again either.
   */
  async terminalVoltage() {
    if (!isPowerDiagFw(this.fwVersion)) return null;
    if (this.voltageSupported === false) return null;
    try {
      const payload = await this.transport.request(CMD.INTERFACE_VOLTAGE, { attempts: 1 });
      this.voltageSupported = true;
      return u16le(payload, 0) / 1000;
    } catch {
      this.voltageSupported = false;
      return null;
    }
  }

  /** Identity, manufacturing data, charge count and lock state. */
  async readStatic() {
    const payload = await this.transport.request(CMD.READ_MSG);
    if (payload.length < 40) throw new ObiError('err.shortResponse', `${payload.length}/40`);

    const chargeCount =
      (((nibbleSwap(payload[34]) << 8) | nibbleSwap(payload[35])) & 0x0fff);

    /* 14.4 V packs are four cells and 18 V packs are five, on the same
     * connector: read five slots from a four-cell pack and the empty one looks
     * like a cell that has died. */
    const cellCount = CELLS_BY_FLAG[nibbleSwap(payload[25])] ?? null;
    this.cellCount = cellCount ?? 5;

    return {
      cellCount,
      romId: hex(payload.slice(0, 8)),
      message: hex(payload.slice(8, 40)),
      chargeCount,
      locked: (payload[28] & 0x0f) > 0,
      statusCode: payload[27].toString(16).padStart(2, '0').toUpperCase(),
      /* Kept as parts, not a formatted string: how a date is written belongs
       * to whoever is reading it, and the pack has no opinion. */
      manufactured: { year: 2000 + payload[0], month: payload[1], day: payload[2] },
      capacityAh: nibbleSwap(payload[24]) / 10,
      batteryType: nibbleSwap(payload[19]),
    };
  }

  /**
   * Model string. Tries the modern command first and falls back to the F0513
   * dialect, recording which one answered so later reads use the right path.
   */
  async readModel() {
    try {
      const payload = await this.transport.request(CMD.MODEL);
      this.dialect = '';
      return { model: new TextDecoder().decode(payload.slice(0, 7)).trim(), limited: false };
    } catch (modernError) {
      try {
        const payload = await this.transport.request(CMD.F0513_MODEL);
        await this.transport.request(CMD.CLEAR);
        this.dialect = 'F0513';
        const digits = `${payload[0].toString(16)}${payload[1].toString(16)}`.toUpperCase();
        return { model: `BL${digits}`, limited: true };
      } catch {
        throw modernError;
      }
    }
  }

  /** Cell voltages and temperatures. */
  async readCells() {
    if (this.dialect === 'F0513') return this.readCellsF0513();

    /* The 1-Wire read is bit-marginal and a flipped bit shows up as a cell at
     * twenty volts. Re-reading clears it; three tries is where the firmware
     * settled, since a pack that has stopped answering never recovers and each
     * attempt costs half a second. */
    for (let attempt = 1; ; attempt += 1) {
      const payload = await this.transport.request(CMD.READ_DATA);
      if (payload.length < 20) throw new ObiError('err.shortResponse', `${payload.length}/20`);

      const slots = [0, 1, 2, 3, 4].map((i) => u16le(payload, 2 + i * 2) / 1000);
      const cells = slots.slice(0, Math.min(this.cellCount, slots.length));
      const packVoltage = u16le(payload, 0) / 1000;

      const sane = packVoltage <= CELL_CEILING * cells.length
        && cells.every((volts) => volts <= CELL_CEILING);
      if (!sane && attempt < 3) continue;
      if (!sane) throw new ObiError('err.implausible', `${packVoltage} V`);

      return {
        packVoltage,
        cells,
        cellDiff: Math.max(...cells) - Math.min(...cells),
        tempCell: u16le(payload, 14) / 100,
        tempMosfet: u16le(payload, 16) / 100,
      };
    }
  }

  /**
   * F0513 has no pack-voltage register — the pack voltage is the sum of the
   * five cell registers 0x31..0x35. Getting those to answer needs the bus
   * primed and each register read more than once, all inside one powered
   * session, which is what firmware command 0x36 does and what no sequence of
   * stock commands can do: the board drops EN between USB commands, so a
   * per-register read starts from cold every time.
   *
   * So the two firmwares get the two paths they can each actually run.
   */
  async readCellsF0513() {
    const cells = isPowerDiagFw(this.fwVersion)
      ? await this.f0513CellsAtomic()
      : await this.f0513CellsPerRegister();

    /* A slot the pack did not answer reads as an implausible voltage; show it as
     * 0 so a failed read is visible rather than a wild number, and keep only the
     * plausible ones for the pack sum. A four-cell F0513 (BL14xx) leaves the
     * fifth slot empty, so a trailing empty slot is dropped from the display —
     * but only when something else came back, or a read that returned nothing
     * at all would present itself as a four-cell pack. */
    const clean = cells.map((v) => (v > 0.1 && v <= CELL_CEILING ? v : 0));
    const valid = clean.filter((v) => v > 0);

    const temp = await this.transport.request(CMD.F0513_TEMP);

    return {
      packVoltage: valid.reduce((sum, v) => sum + v, 0),
      cells: clean[4] === 0 && valid.length ? clean.slice(0, 4) : clean,
      cellDiff: valid.length ? Math.max(...valid) - Math.min(...valid) : 0,
      tempCell: u16le(temp, 0) / 100,
      tempMosfet: null,
    };
  }

  /** PowerDiag firmware: one command, five u16 LE back. The long timeout covers
   * the firmware's own priming and retries. */
  async f0513CellsAtomic() {
    const payload = await this.transport.request(CMD.F0513_CELLS, { attempts: 1, timeoutMs: 12000 });
    return [0, 1, 2, 3, 4].map((i) => u16le(payload, i * 2) / 1000);
  }

  /** Stock firmware: one register per command, the way upstream reads them.
   * Deliberately left as upstream has it — no priming, no repeats, no CLEAR
   * (which on F0513 zeroes the registers outright). Cells a cold read does not
   * reach come back implausible and are shown as 0 by the caller. */
  async f0513CellsPerRegister() {
    const cells = [];
    for (const command of CMD.F0513_VCELL) {
      const payload = await this.transport.request(command);
      cells.push(u16le(payload, 0) / 1000);
    }
    return cells;
  }

  async ledsOn() {
    await this.transport.request(CMD.TESTMODE);
    await this.transport.request(CMD.LEDS_ON);
  }

  async ledsOff() {
    await this.transport.request(this.dialect === 'F0513' ? CMD.F0513_TESTMODE : CMD.TESTMODE);
    await this.transport.request(CMD.LEDS_OFF);
  }

  /** Enter test mode, then clear the error flags that lock the pack out. */
  async clearErrors() {
    await this.transport.request(CMD.TESTMODE);
    await this.transport.request(CMD.RESET_ERROR);
  }
}
