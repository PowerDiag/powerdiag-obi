# Flash-Nano.ps1 — batch flasher for OBI Nano clones

Flashes the ArduinoOBI firmware onto the Arduino Nano clones used by this project
(both the **FTDI** and **CH340** variants). Written for flashing many boards in a row.

## Why not just use `pio run -t upload` / avrdude?

These clones' **auto-reset does not work** with avrdude/PlatformIO — avrdude pulses the
reset line once at the start, the optiboot window is only ~1 s, and the clones' DTR wiring
doesn't cooperate. Result: `avrdude: stk500_getsync(): not in sync` at every baud, forever.

This script talks the **STK500v1** protocol directly and **pulses DTR+RTS itself** to enter
the bootloader, so no button pressing and no timing luck required. It also **verifies** the
flash by reading every page back, then confirms the firmware boots by querying its version.

## Requirements

- Windows PowerShell (the built-in `powershell.exe` is fine).
- The compiled firmware at `..\.pio\build\nano\firmware.hex`.
  Build/refresh it with: `pio run -e nano`  (run from the `ArduinoOBI` folder).
- The board's USB-serial driver installed (FTDI or CH340). No PlatformIO needed at flash time.

## Usage

Run from this `tools` folder.

### One board
```powershell
.\Flash-Nano.ps1
```
Auto-detects the connected adapter (FTDI / CH340 / CP210x / genuine Arduino) and flashes it.
Exit code `0` = success, `1` = failure (handy for scripting).

### Many boards — LOOP MODE (recommended for the 100-board run)
```powershell
.\Flash-Nano.ps1 -Loop
```
Then just: **plug a board → it flashes & verifies → unplug it → plug the next → repeat.**
It prints a running `total OK / failed` tally. `Ctrl+C` to stop.

> Plug in **one board at a time**. If two adapters are connected it pauses and asks you to
> get down to one, so it never flashes the wrong device.

### Useful options
| Option           | Default                          | Purpose                                            |
|------------------|----------------------------------|----------------------------------------------------|
| `-Port COMx`     | auto-detect                      | Force a specific port (skip auto-detect).          |
| `-Hex <path>`    | `..\.pio\build\nano\firmware.hex`| Flash a different hex file.                         |
| `-BootBaud`      | `115200,57600`                   | Bootloader sync bauds to try, in order.            |
| `-AppBaud`       | `9600`                           | OBI firmware serial baud, for the post-flash check.|
| `-NoVerifyRun`   | off                              | Skip the version query (read-back verify still runs). |

## What a good run looks like
```
Firmware: firmware.hex  (3368 bytes, 27 pages)

[COM10] flashing...
  synced @ 115200 baud
[COM10] OK - firmware running, version 0.2.1
```

## Troubleshooting

- **`No FTDI serial port found`** — board not plugged in, or driver missing. Plug it in / install
  the CH340 or FTDI driver, then re-run. `-Loop` will simply wait until a board appears.
- **`Multiple FTDI ports found`** — more than one adapter is connected. Unplug the others, or
  pass `-Port COMx`. In `-Loop` mode, keep to one board at a time.
- **Port number changes between boards (e.g. COM12 → COM10)** — normal; some counterfeit-FTDI
  clones re-enumerate on a new COM number after resets. Auto-detect handles it; that's why you
  should prefer auto-detect over `-Port` for the batch run.
- **`Could not enter bootloader`** — usually the board was unplugged mid-flash, or a dead/erased
  bootloader. Re-seat the USB cable and retry. If a specific board never syncs, its bootloader may
  be gone (needs an ISP programmer to restore) — set it aside.
- **`Firmware not found`** — build it: `pio run -e nano` from the `ArduinoOBI` folder.

## Notes

- Bootloader is optiboot @ **115200** on these boards (the script also tries 57600 as a fallback).
- After flashing, the OBI firmware runs its serial protocol at **9600 baud** — that's what the
  OBI GUI (and the script's post-flash check) uses, not the bootloader baud.
- Flash page size is 128 bytes (atmega328p). The read-back verify compares every byte.
