"""
@module measure-tilesets
@description The evidence behind the PLANNED schema 67 — see docs/DOCUMENT-SCHEMA.md.

Kept in the repo rather than left in a scratchpad because the design cites its numbers, and a design
whose evidence cannot be re-run is a design nobody can check. Re-run it before starting the work: a
corpus that has grown may have changed the answer.

WHAT DO REAL TILESETS ACTUALLY CARRY? The schema change should be shaped by the corpus, not by the
format's feature list — Tiled can express a great deal that nobody in this tree uses, and a field
designed against nothing is a field that will be wrong when something finally arrives.

Counts per FEATURE and per FILE, over every .tsx and every embedded <tileset> in every .tmx.
"""
import os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOTS = [
    r"C:\Program Files\Tiled\examples",
    r"C:\Users\micha\Documents\code projects\f1\New folder\freeassets",
    r"C:\Users\micha\Documents\code projects\f1\New folder",
]

files = []
seen = set()
for root in ROOTS:
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, names in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "dist", "__MACOSX")]
        for n in names:
            if n.lower().endswith((".tsx", ".tmx")):
                full = os.path.join(dirpath, n)
                key = (n.lower(), os.path.getsize(full))
                if key in seen:
                    continue
                seen.add(key)
                files.append(full)

print(f"{len(files)} tileset/map files\n")

FEATURES = {
    "per-tile probability":   re.compile(r"<tile\b[^>]*\bprobability\s*=", re.I),
    "per-tile <properties>":  re.compile(r"<tile\b[^>]*>\s*<properties", re.I | re.S),
    "per-tile <animation>":   re.compile(r"<animation\b", re.I),
    "per-tile <objectgroup>": re.compile(r"<tile\b[^>]*>\s*(?:<properties>.*?</properties>\s*)?<objectgroup", re.I | re.S),
    "per-tile class/type":    re.compile(r"<tile\b[^>]*\b(?:type|class)\s*=", re.I),
    "<wangsets>":             re.compile(r"<wangset\b", re.I),
    "<tileoffset>":           re.compile(r"<tileoffset\b", re.I),
    "collection <tile><image>": re.compile(r"<tile\b[^>]*>\s*<image\b", re.I | re.S),
    "<terraintypes> (legacy)": re.compile(r"<terraintypes\b", re.I),
    "<transformations>":      re.compile(r"<transformations\b", re.I),
    "<grid> (isometric set)": re.compile(r"<grid\b", re.I),
}

file_hits = collections.Counter()
occurrence = collections.Counter()
examples = collections.defaultdict(list)

for f in files:
    try:
        text = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    for name, rx in FEATURES.items():
        found = rx.findall(text)
        if found:
            file_hits[name] += 1
            occurrence[name] += len(found)
            if len(examples[name]) < 3:
                examples[name].append(os.path.basename(f))

print(f"{'feature':28} {'files':>6} {'total':>7}   where")
for name in FEATURES:
    if file_hits[name] == 0:
        print(f"{name:28} {'-':>6} {'-':>7}   (absent from the whole corpus)")
    else:
        print(f"{name:28} {file_hits[name]:>6} {occurrence[name]:>7}   {', '.join(examples[name])}")

# THE PER-TILE PAYLOAD, in detail: what a `<tile>` element actually says when it says anything.
attrs = collections.Counter()
child = collections.Counter()
tiles_with_body = 0
for f in files:
    try:
        text = open(f, encoding="utf-8", errors="replace").read()
    except Exception:
        continue
    for m in re.finditer(r"<tile\b([^>]*?)(/?)>", text, re.I):
        for a in re.findall(r"\b([a-z]+)\s*=", m.group(1), re.I):
            attrs[a.lower()] += 1
    for m in re.finditer(r"<tile\b[^>]*[^/]>(.*?)</tile>", text, re.I | re.S):
        tiles_with_body += 1
        for c in set(re.findall(r"<([a-z]+)\b", m.group(1), re.I)):
            child[c.lower()] += 1

print(f"\n<tile> ATTRIBUTES seen: {dict(attrs.most_common(8))}")
print(f"<tile> with a BODY: {tiles_with_body}; children: {dict(child.most_common(8))}")
