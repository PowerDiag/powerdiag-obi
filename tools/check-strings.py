"""Flag string literals that a line break has broken open.

This is the failure that took the whole app down once: a script written by a
tool that ate an escape, leaving a real newline inside a quoted string. The
browser answers a syntax error with silence — the file is served, nothing
runs — so it has to be caught before it ships.

Done as a scan rather than with regexes, because the shortcuts all misfire on
real code: "//" appears inside 'edge://apps', apostrophes appear inside
comments, and stripping block comments by pattern renumbers every line after
the first one.

    python tools/check-strings.py
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKSLASH = chr(92)


def broken_strings(source):
    """Line numbers where a quoted string ran into a line break."""
    problems = []
    state = "code"          # code | line-comment | block-comment | ' | " | `
    line = 1
    opened_at = 0
    i = 0

    while i < len(source):
        char = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if char == "\n":
            if state in ("'", '"'):
                problems.append((opened_at, state))
                state = "code"          # resync rather than cascade
            elif state == "line-comment":
                state = "code"
            line += 1
            i += 1
            continue

        if state == "code":
            if char == "/" and nxt == "/":
                state, i = "line-comment", i + 2
            elif char == "/" and nxt == "*":
                state, i = "block-comment", i + 2
            elif char in ("'", '"', "`"):
                state, opened_at, i = char, line, i + 1
            else:
                i += 1
        elif state == "block-comment":
            if char == "*" and nxt == "/":
                state, i = "code", i + 2
            else:
                i += 1
        elif state == "line-comment":
            i += 1
        else:                            # inside a string of some kind
            if char == BACKSLASH:
                i += 2                   # escape: skip whatever follows
            elif char == state:
                state, i = "code", i + 1
            else:
                i += 1

    return problems


targets = []
for folder in ("web", "web/js"):
    directory = os.path.join(ROOT, folder)
    if not os.path.isdir(directory):
        continue
    for name in sorted(os.listdir(directory)):
        if name.endswith(".js"):
            targets.append(os.path.join(directory, name))

failed = False
for path in targets:
    source = io.open(path, encoding="utf-8").read()
    rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
    for number, quote in broken_strings(source):
        print("::error file=%s,line=%d::string opened with %s runs past the line end"
              % (rel, number, quote))
        failed = True

print("%d scripts checked" % len(targets))
sys.exit(1 if failed else 0)
