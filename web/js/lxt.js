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
};

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const u16le = (payload, offset) => payload[offset] | (payload[offset + 1] << 8);

const nibbleSwap = (byte) => ((byte & 0xf0) >> 4) | ((byte & 0x0f) << 4);

export class LxtBattery {
  constructor(transport) {
    this.transport = transport;
    this.dialect = null;      // null until a model read succeeds, then '' or 'F0513'
    this.voltageSupported = null; // null = not probed, false = board has no divider
  }

  reset() {
    this.dialect = null;
    this.voltageSupported = null;
  }

  /** Firmware version of the interface board itself, e.g. "0.3.0". */
  async interfaceVersion({ attempts = 5 } = {}) {
    const payload = await this.transport.request(CMD.INTERFACE_VERSION, { attempts });
    return Array.from(payload).join('.');
  }

  /**
   * Pack voltage measured by the board on the battery terminals, in volts.
   * Needs the R10/R11 divider and firmware 0.3.0 or newer; stock OBI hardware
   * simply does not answer, and is then not asked again.
   */
  async terminalVoltage() {
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

    return {
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

    const payload = await this.transport.request(CMD.READ_DATA);
    if (payload.length < 20) throw new ObiError('err.shortResponse', `${payload.length}/20`);

    const cells = [0, 1, 2, 3, 4].map((i) => u16le(payload, 2 + i * 2) / 1000);
    return {
      packVoltage: u16le(payload, 0) / 1000,
      cells,
      cellDiff: Math.max(...cells) - Math.min(...cells),
      tempCell: u16le(payload, 14) / 100,
      tempMosfet: u16le(payload, 16) / 100,
    };
  }

  async readCellsF0513() {
    /* These packs need the bus settled before they answer reliably. */
    await this.transport.request(CMD.CLEAR);
    await this.transport.request(CMD.CLEAR);

    const cells = [];
    for (const command of CMD.F0513_VCELL) {
      const payload = await this.transport.request(command);
      cells.push(u16le(payload, 0) / 1000);
    }
    const temp = await this.transport.request(CMD.F0513_TEMP);

    return {
      packVoltage: cells.reduce((sum, v) => sum + v, 0),
      cells,
      cellDiff: Math.max(...cells) - Math.min(...cells),
      tempCell: u16le(temp, 0) / 100,
      tempMosfet: null,
    };
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
