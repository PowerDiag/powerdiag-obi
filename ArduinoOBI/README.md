# ArduinoOBI

## Hardware

This simple interface can be built using an Arduino Nano and some external resistors.

![screenshot](../docs/images/arduino-obi.png)

For the interface board of this fork (Arduino Nano, WS2812 status LED, two buttons and pack voltage
measurement) see the [main README](../README.md#hardware-obi-interface-board).

---

## Stand-alone operation

The board can be used without the PC application. The battery-facing commands are exactly the
frames the PC application sends, so a local read behaves identically to a read from the software.

### Buttons

Both buttons act on a **1 second hold** (`BTN_HOLD_MS`), not on a plain press, so a bumped button
never talks to the battery. The LED blinks while a button is held; releasing early cancels.

| Button | Pin | Hold | Action |
| ------ | --- | ---- | ------ |
| BTN1 (U4) | D3 | 1 s | Read the battery message and latch the result on the LED |
| BTN1 (U4) | D3 | 1 s | **While red/green is alternating:** unlock the BMS, then read back |
| BTN2 (U3) | D2 | 1 s | Dismiss the latched result, back to the idle voltage display |

The unlock path is the same two frames the PC application sends for *Clear errors*: test mode
(`D9 96 A5`) followed by reset error (`DA 04`). It only runs from the locked state, so the write to
the BMS cannot happen unless the board has actually read a locked battery first.

### Status LED (WS2812 on D4)

| Colour | Pattern | Meaning |
| ------ | ------- | ------- |
| Red, green, blue | once at power-up | Firmware started, and all three channels work |
| Dark | — | Idle. The LED speaks only about the last read |
| Blue | blink | BTN1 held, and talking to the battery |
| **Green** | **solid** | **Read OK — BMS is unlocked** |
| **Red / green** | **alternating** | **Read OK — BMS is LOCKED**, hold BTN1 again to unlock |
| Magenta | fast blink | No usable answer (all `0x00` / all `0xFF`) — check the pack is seated |
| White | fast blink | BTN2 held, result is about to be dismissed |
| Cyan | fast blink | Unlock done, reading back |

The LED does not show the pack voltage. It did, as a red-to-green gradient, and that made green mean
two unrelated things — a full pack, and an unlocked one — told apart only by whether a result
happened to be latched, which nobody can see. The voltage is on the PC to three decimal places; the
lock state is the only thing this board can tell you on its own.

Results are **latched**: they stay on the LED until BTN2 dismisses them or another read replaces
them. Only then does the LED return to the idle voltage indication. Brightness is set by
`STATUS_LED_BRIGHTNESS`.

The firmware prints nothing extra on the serial port, so the PC application protocol is unaffected
by local button use.

---

## Pack voltage over USB

Interface command **`0x02`** returns the voltage measured on the battery terminals, so the PC
application can display it without a battery data read:

```text
request : 01 00 02 02
response: 02 02 <millivolts, little endian>
```

The PC application requests it once per read and shows it as *Terminal Voltage (measured)*.
Interfaces or older firmware that do not answer this command are handled gracefully — the field is
simply left empty.

The reading is referenced to the ATmega328P's internal 1.1 V bandgap, whose absolute value is only
specified as 1.0–1.2 V, so set `VBAT_CALIBRATION` in `src/main.cpp` once per board before relying on
the value. Full scale is 23.1 V. See [Calibration](../README.md#calibration) in the main README.

---

## Prerequisites

Ensure you have the following installed on your system:

1. **VS Code (Visual Studio Code)**  
   Download from [here](https://code.visualstudio.com/).

2. **PlatformIO Extension for VS Code**  
   Install the PlatformIO extension from the Extensions Marketplace in VS Code.

3. **Git (OPTIONAL)**  

4. **Arduino Nano**  
   Ensure you have a working Arduino Nano board and a USB cable to connect it to your computer.
   Build the circuit according to the schematic.

---

## Step 1: Clone the ArduinoOBI Repository

1. Open your terminal.
2. Clone the repository using the command:

   ```bash
   git clone https://github.com/mnh-jansson/open-battery-information.git
   ```

Or,

1. Download the repository as a .ZIP file.
---

## Step 2: Open the Project in VS Code

  Open VS Code.
  Go to File > Open Folder and select the ArduinoOBI project folder.
  PlatformIO will automatically detect the project. If not, ensure the folder contains a platformio.ini file.

## Step 3: Compile the Project

  Open the PlatformIO sidebar by clicking on the PlatformIO icon in the VS Code activity bar.
  Click on the "Project Tasks" dropdown for nano.
  Under "General", click Build to compile the code.
  Check the output terminal for any errors. A successful build will show a "Success" message.

## Step 4: Flash the Code to the Arduino Nano

  Connect your Arduino Nano to your computer using a USB cable.
  In the PlatformIO sidebar, go to the "Project Tasks" dropdown for nano.
  Under "General", click Upload.
  PlatformIO will detect the correct port and upload the firmware to your Arduino Nano.
  A successful upload will display an "Upload complete" message in the terminal.
