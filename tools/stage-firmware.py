#!/usr/bin/env python3
"""Rebuild the Nano firmware and stage it for the web flasher.

The browser flasher serves its images out of `web/firmware/`, which means a
build artefact has to be committed. That is a standing invitation for the
committed image to fall behind `ArduinoOBI/src/main.cpp` without anyone
noticing — and the failure is invisible, because the flash still succeeds and
still verifies. It just writes last week's firmware.

So there is one command that does the whole thing, and the version in the
catalogue is read out of the source rather than typed:

    python tools/stage-firmware.py

Run it after any firmware change, before committing.
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "ArduinoOBI", ".pio", "build", "nano", "firmware.hex")
STAGE = os.path.join(ROOT, "web", "firmware")
INDEX = os.path.join(STAGE, "index.json")


def firmware_version():
    source = io.open(os.path.join(ROOT, "ArduinoOBI", "src", "main.cpp"), encoding="utf-8").read()
    parts = []
    for name in ("MAJOR", "MINOR", "PATCH"):
        match = re.search(r"#define ARDUINO_OBI_VERSION_%s (\d+)" % name, source)
        if not match:
            sys.exit("cannot find ARDUINO_OBI_VERSION_%s in main.cpp" % name)
        parts.append(match.group(1))
    return ".".join(parts)


def programmed_bytes(path):
    """Bytes of program, not bytes of file — what the progress bar counts."""
    total = 0
    for line in io.open(path, encoding="utf-8"):
        line = line.strip()
        if line.startswith(":") and line[7:9] == "00":
            total += int(line[1:3], 16)
    return total


def main():
    print("building...")
    subprocess.run(
        ["pio", "run", "-e", "nano"],
        cwd=os.path.join(ROOT, "ArduinoOBI"),
        check=True,
    )
    shutil.copyfile(BUILD, os.path.join(STAGE, "powerdiag-obi.hex"))

    catalogue = json.load(io.open(INDEX, encoding="utf-8"))
    for image in catalogue["images"]:
        path = os.path.join(STAGE, image["file"])
        if not os.path.exists(path):
            sys.exit("catalogue names a file that is not staged: %s" % image["file"])
        if image["id"] == "powerdiag":
            image["version"] = firmware_version()
        image["bytes"] = programmed_bytes(path)
        print("  %-10s v%-8s %5d B  %s" % (image["id"], image["version"], image["bytes"], image["file"]))

    io.open(INDEX, "w", encoding="utf-8", newline="\n").write(
        json.dumps(catalogue, indent=2) + "\n"
    )
    print("staged. Bump CACHE in web/sw.js so returning users get the new image.")


if __name__ == "__main__":
    main()
