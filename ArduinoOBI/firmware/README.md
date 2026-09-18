# ArduinoOBI prebuilt firmware

Prebuilt firmware images, kept so an old build can be flashed back without
reconstructing a toolchain.

| Version | Source | Notes |
|---------|--------|-------|
| [upstream-0.2.1](upstream-0.2.1/) | upstream `1a24a38`, unmodified | Stock ArduinoOBI. Serial bridge only — no LED, buttons or voltage sensing. |

This repo's own firmware is built from `src/` and numbers itself `9.x.x`, which is how the web app
tells the two apart; see [Firmware versions](../README.md#firmware-versions).

Flash with `ArduinoOBI/tools/Flash-Nano.ps1`; each folder has its own `FLASH.md`.
