"""Check every language defines every string.

Seven languages now. A key added to one and forgotten in the others falls back
to English silently, so a Japanese customer gets one English line in the middle
of a sentence and nobody notices until they mention it.

    python tools/check-i18n.py
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "js", "i18n.js")

src = io.open(SRC, encoding="utf-8").read()

LANG_RE = re.compile(r"^  '?([a-zA-Z-]+)'?: \{$", re.M)
KEY_RE = re.compile(r"'([a-zA-Z]+\.[A-Za-z]+)':")
END = chr(10) + "  },"


def keys_of(lang):
    tag = "  '%s': {" % lang if "-" in lang else "  %s: {" % lang
    start = src.index(tag)
    return set(KEY_RE.findall(src[start:src.index(END, start)]))


langs = LANG_RE.findall(src)
if "en" not in langs:
    print("no English block to compare against")
    sys.exit(1)

base = keys_of("en")
failed = False

for lang in langs:
    missing = sorted(base - keys_of(lang))
    extra = sorted(keys_of(lang) - base)
    if missing:
        print("::error::%s is missing %s" % (lang, missing))
        failed = True
    if extra:
        print("::warning::%s defines keys English does not: %s" % (lang, extra))

print("%d languages, %d keys each" % (len(langs), len(base)))
sys.exit(1 if failed else 0)
