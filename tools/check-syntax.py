#!/usr/bin/env python3
"""Parse every script in web/ and fail if any of them does not.

CI runs `node --check`, which is the real gate. This exists because a machine
without a Node install has no way to catch a syntax error before pushing, and
the one time that happened the whole app silently failed to execute: an
unterminated string literal, a blank language menu, a dead Connect button, and
an HTTP 200 on every file.

Module syntax cannot appear inside a function body, so the top-level import and
export keywords are neutralised before the source is handed to QuickJS as a
function expression. That parses every statement without running any of them;
anything the stripping does not touch is checked verbatim.

    pip install quickjs && python tools/check-syntax.py
"""

import io
import pathlib
import re
import sys

try:
    import quickjs
except ImportError:
    sys.exit("needs quickjs: pip install quickjs")

IMPORT = re.compile(r"(?m)^import\s.*?;\s*$")
EXPORT_DECL = re.compile(r"(?m)^export\s+(?=(default\s+)?(class|function|const|let|var|async))")
EXPORT_LIST = re.compile(r"(?m)^export\s*\{[^}]*\}\s*;?\s*$")

root = pathlib.Path(__file__).resolve().parent.parent
failures = 0

for path in sorted(root.glob("web/**/*.js")):
    source = io.open(path, encoding="utf-8").read()
    body = IMPORT.sub(";", source)
    body = EXPORT_DECL.sub("", body)
    body = EXPORT_LIST.sub(";", body)
    try:
        quickjs.Context().eval("(function(){" + body + "\n})")
    except Exception as error:  # noqa: BLE001 - any parse failure is a failure
        print("FAIL  %s\n      %s" % (path.relative_to(root), error))
        failures += 1
    else:
        print("ok    %s" % path.relative_to(root))

sys.exit(1 if failures else 0)
