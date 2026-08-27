# ArduinoOBI upstream firmware — v0.2.1

The **unmodified upstream** ArduinoOBI firmware, kept here so a board can always
be put back to stock: to reproduce a bug against the original, to check whether
behaviour we changed was already there, or to hand someone a board running the
same code as the upstream project.

## Provenance

Built from [mnh-jansson/open-battery-information](https://github.com/mnh-jansson/open-battery-information)
at commit `1a24a38`, PlatformIO `nano` env, unmodified sources.

* `ArduinoOBI-upstream-v0.2.1.hex` — 3368 bytes, 27 flash pages
* SHA256 `a499e89e9b548c81de451573d9744090d39b7b43f7e2322d04b1695fdc1832fd`

Reports **0.2.1** over the serial version command, which is how you tell it apart
from this repo's firmware at a glance.

## Flashing

```powershell
cd ArduinoOBI/tools
.\Flash-Nano.ps1 -Hex ../firmware/upstream-0.2.1/ArduinoOBI-upstream-v0.2.1.hex
```

Use the script rather than `pio run -t upload` or plain avrdude: on the FTDI and
CH340 Nano clones this project uses, the auto-reset does not cooperate with
avrdude — it pulses reset once, the optiboot window is about a second, and you
get `stk500_getsync(): not in sync` at every baud, forever. The script speaks
STK500v1 and pulses DTR+RTS itself, reads every page back to verify, then
confirms the firmware booted by querying its version.

A good run ends with:

```
[COM12] OK - firmware running, version 0.2.1
```

## Differences from this repo's firmware

Upstream is the serial bridge only — the PC application drives everything. It
has no support for the interface board's additions: no WS2812 status LED, no
buttons, no pack voltage sensing. Flashing it onto an assembled board leaves the
LED dark and the buttons dead; that is expected, not a fault.

The battery-facing 1-Wire code in this repo is deliberately unchanged from
upstream, so reads behave identically either way.
