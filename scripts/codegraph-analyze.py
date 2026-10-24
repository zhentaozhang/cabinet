#!/usr/bin/env python3
"""Barrel-aware dependency analysis: counts `export ... from` as an edge too."""
import sqlite3, os, re, collections

ROOT = "/Users/zhentao/Documents/Workspace/Cabinet"
con = sqlite3.connect(os.path.join(ROOT, ".codegraph/codegraph.db"))
os.chdir(ROOT)

FILES = {r[0] for r in con.execute("SELECT path FROM files")}
# The index only refreshes from disk while a watcher is running, so a file
# deleted since the last index still sits in the DB and would be reported as an
# orphan. Drop those, but say so: a stale index quietly changes the numbers.
GHOSTS = sorted(f for f in FILES if not os.path.exists(f))
if GHOSTS:
    print(f"### Index is stale: {len(GHOSTS)} indexed file(s) no longer on disk "
          f"(re-run `codegraph init .` after deleting .codegraph/)")
    for g in GHOSTS[:5]: print(f"- {g}")
    print()
FILES = {f for f in FILES if os.path.exists(f)}
SRC = sorted(f for f in FILES if f.endswith((".ts", ".tsx")))

def resolve(spec, importer):
    if spec.startswith("@/"):
        base = "src/" + spec[2:]
    elif spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    else:
        return None
    for c in (base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"):
        if c in FILES:
            return c
    if base in FILES:
        return base
    return None

IMPORT_RE = re.compile(r'^\s*(?:import|export)\s+([^;]*?)\s*from\s+["\']([^"\']+)["\']', re.M)
SIDE_RE = re.compile(r'^\s*import\s+["\']([^"\']+)["\']', re.M)

def is_type_only(clause):
    """TypeScript erases type-only imports, so they are not runtime edges.

    `import type { X } from "./y"` and `import { type X, type Y } from "./y"`
    leave nothing behind in the emitted JavaScript; counting them as edges
    invents cycles that the running program does not have (the one this script
    used to report, policy.ts <-> standing-grants.ts, was exactly that)."""
    c = clause.strip()
    if c.startswith("type "):
        return True
    if c.startswith("{") and c.endswith("}"):
        names = [n.strip() for n in c[1:-1].split(",") if n.strip()]
        return bool(names) and all(n.startswith("type ") for n in names)
    return False

# deps: edges that survive compilation. type_deps: erased. Cycles and the layer
# matrix use deps only; orphan detection uses both, because a module that is
# only ever imported for its types is still depended on.
deps, type_deps = collections.defaultdict(dict), collections.defaultdict(dict)
kinds = collections.Counter()
ext = collections.Counter()
for f in SRC:
    try:
        text = open(f, encoding="utf-8").read()
    except OSError:
        continue
    edges = {(spec, True) for clause, spec in IMPORT_RE.findall(text) if is_type_only(clause)}
    edges |= {(spec, False) for clause, spec in IMPORT_RE.findall(text) if not is_type_only(clause)}
    edges |= {(spec, False) for spec in SIDE_RE.findall(text)}
    for s, erased in edges:
        t = resolve(s, f)
        if t:
            if t != f:
                bucket = type_deps if erased else deps
                bucket[f][t] = bucket[f].get(t, 0) + 1
            kinds["type-only" if erased else "internal"] += 1
        elif not s.startswith(("@/", ".")):
            ext[s.split("/")[0] if not s.startswith("@") else "/".join(s.split("/")[:2])] += 1

def layer(f):
    if f.startswith("src/contracts"): return "contracts"
    if f.startswith("src/lib"): return "lib"
    if f.startswith("src/server"): return "server"
    if f.startswith("src/components"): return "components"
    if f.startswith("src/app/api"): return "app/api"
    if f.startswith("src/app"): return "app/pages"
    if f.startswith("src/proxy"): return "proxy"
    if f.startswith("scripts"): return "scripts"
    if f.startswith("tests"): return "tests"
    return "config"

layers = ["contracts", "lib", "server", "components", "app/api", "app/pages", "proxy", "scripts", "tests", "config"]
mat = collections.Counter()
for f, ts in deps.items():
    for t in ts:
        a, b = layer(f), layer(t)
        if a != b:
            mat[(a, b)] += 1
print("### Layer matrix (barrel-aware), rows import columns")
print("| from \\ to | " + " | ".join(layers) + " |")
print("|---" * (len(layers) + 1) + "|")
for a in layers:
    print(f"| **{a}** | " + " | ".join(str(mat.get((a, b), 0)) or "·" for b in layers) + " |")

fan_in = collections.Counter()
for f, ts in deps.items():
    for t in ts: fan_in[t] += 1

print("\n### Barrels (files whose only job is re-export)")
barrels = []
for f in SRC:
    if not os.path.basename(f).startswith("index.") and f != "src/components/actions.tsx":
        continue
    try: text = open(f, encoding="utf-8").read()
    except OSError: continue
    if re.fullmatch(r'(?:\s*export\s+(?:\*|\{[^}]*\})\s+from\s+"[^"]+";?\s*)+', text):
        barrels.append(f)
for f in barrels:
    inner = len(deps.get(f, ()))
    print(f"- {f}: re-exports {inner} module(s), imported by {fan_in.get(f,0)} file(s)")

# real orphans = zero fan-in after barrel expansion, counting type-only
# importers too (a module imported only for its types is still in use).
fan_in_any = collections.Counter()
for f, ts in list(deps.items()) + list(type_deps.items()):
    for t in ts: fan_in_any[t] += 1
ENTRY = re.compile(r'/(page|layout|route|error|loading|not-found)\.tsx?$|\.config\.|proxy\.ts$')
orphans = [f for f in SRC if not fan_in_any.get(f) and not ENTRY.search(f)
           and not f.startswith(("tests/", "scripts/"))]
print(f"\n### True orphans (zero importers incl. barrels): {len(orphans)}")
for f in orphans: print(f"- {f}")

print(f"\n### Top fan-in (barrel-aware)")
for f, c in fan_in.most_common(20): print(f"- {c:3d}  {f}  [{layer(f)}]")

# cycles via Tarjan (iterative)
idx, low, on, st, sccs, ctr = {}, {}, {}, [], [], [0]
for root in sorted(deps):
    if root in idx: continue
    work = [(root, iter(sorted(deps.get(root, {}))))]
    idx[root] = low[root] = ctr[0]; ctr[0] += 1; st.append(root); on[root] = True
    while work:
        node, it = work[-1]
        adv = False
        for w in it:
            if w not in idx:
                idx[w] = low[w] = ctr[0]; ctr[0] += 1; st.append(w); on[w] = True
                work.append((w, iter(sorted(deps.get(w, {}))))); adv = True; break
            if on.get(w): low[node] = min(low[node], idx[w])
        if adv: continue
        work.pop()
        if work: low[work[-1][0]] = min(low[work[-1][0]], low[node])
        if low[node] == idx[node]:
            comp = []
            while True:
                w = st.pop(); on[w] = False; comp.append(w)
                if w == node: break
            if len(comp) > 1: sccs.append(sorted(comp))
print(f"\n### Import cycles (SCC > 1): {len(sccs)}")
for c in sorted(sccs, key=len, reverse=True)[:10]:
    print(f"- ({len(c)}) " + " -> ".join(c))

# reverse: who imports server/readmodels internals
print("\n### Who reaches into app/api? (should be nobody)")
for f, ts in sorted(deps.items()):
    if any(t.startswith("src/app/") for t in ts) and not f.startswith(("src/app/", "tests/")):
        print(f"- {f} -> {[t for t in ts if t.startswith('src/app/')]}")

# route -> service direct coupling
print("\n### app/api routes importing server/* directly")
n = 0
for f, ts in sorted(deps.items()):
    if f.startswith("src/app/api/"):
        s = [t for t in ts if t.startswith("src/server/")]
        if s: n += 1
print(f"   {n} of {sum(1 for f in SRC if f.startswith('src/app/api/') and f.endswith('route.ts'))} route files")
