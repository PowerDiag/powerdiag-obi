# ArduinoOBI prebuilt firmware

Prebuilt firmware images, kept so an old build can be flashed back without
reconstructing a toolchain.

| Version | Source | Notes |
|---------|--------|-------|
| [upstream-0.2.1](upstream-0.2.1/) | upstream `1a24a38`, unmodified | Stock ArduinoOBI. Serial bridge only — no LED, buttons or voltage sensing. |

Flash with `ArduinoOBI/tools/Flash-Nano.ps1`; each folder has its own `FLASH.md`.
