# Validation task: `fix(router): do not copy URL-sized objects into every route snapshot`

**Repo:** `angular/angular` · **PR:** [#70933](https://github.com/angular/angular/pull/70933) · **Issue:** [#70932](https://github.com/angular/angular/issues/70932)
**Base commit:** `846c73d52be8104aea826da5d4d95814fd24b117`

You are validating a security patch. Work in a disposable sandbox. Do not push anything.
Every command below has been run end to end on Linux x64 / node 22.22 and produces the output shown.

---

## 1. What the patch claims

Angular's route recognition copied URL-sized objects into **every** `ActivatedRouteSnapshot` it
created. A URL controls how many snapshots get created — an empty-path route matches once for every
auxiliary outlet the URL names — so recognizing one URL cost the **product** of two attacker-chosen
numbers.

Three allocation sites, all reached by one unauthenticated GET:

| # | Site | Copied per snapshot | What drives its width |
|---|---|---|---|
| 1 | `Recognizer.createSnapshot` | `Object.freeze({...this.urlTree.queryParams})` | the query string |
| 2 | `getInherited()` | `{...parent.params, ...route.params}` | **matrix params** on a consumed segment |
| 3 | `getInherited()` | a four-way spread for `resolve` that `createSnapshot` never reads | the route's static `data` |

The patch shares the frozen objects instead, and builds `resolve` on first read.

**The claim you are testing is not "it got faster".** It is:

> Sites 2 and 3 are reachable **with no query string at all**, so a fix that only shares
> `queryParams` leaves a byte-for-byte equivalent attack alive.

---

## 2. Gates

Report each as PASS / FAIL / BLOCKED. Do not stop at the first failure.

| Gate | What it proves | § |
|---|---|---|
| **A** | The patch does not break the router | 5 |
| **B** | All three attack shapes are closed | 6.2 |
| **B′** | A `queryParams`-only fix would **not** be enough | 6.3 |
| **B″** | A bounded worker survives concurrency | 6.4 |
| **C** | Sharing is real and not observable | 7 |
| **D** | The bundle symbol golden is untouched | 5 |

---

## 3. Environment

```bash
node --version      # expect >= 22
pnpm install
```

**Use `node_modules/.bin/bazelisk`, never a system `bazel`** — a system `bazel` resolves a stale
workspace and every result is meaningless. If `pnpm install` rewrites `pnpm-lock.yaml`, restore it
before running Bazel.

---

## 4. Apply the patch

If you have the branch:

```bash
git checkout fix/router-recognize-snapshot-copies
```

Otherwise write **Appendix A** to `70933.patch` and:

```bash
git checkout -b validate/70933 846c73d52be8104aea826da5d4d95814fd24b117
git apply --index 70933.patch
git commit -m "fix(router): do not copy URL-sized objects into every route snapshot"
```

Expected footprint — **3 files, nothing else**:

```
packages/router/src/recognize.ts         +32
packages/router/src/router_state.ts     +114
packages/router/test/recognize.spec.ts   +97
```

```bash
git diff --stat 846c73d52be8104aea826da5d4d95814fd24b117
```

If any other file is modified, this is not the scoped-down patch. Say so and stop.

---

## 5. Gate A + D — correctness

```bash
node_modules/.bin/bazelisk test //packages/router/... //packages/core/test/bundling/router:symbol_test
```

**PASS =** all 17 router targets plus `symbol_test` green, including `test_web_chromium` and
`test_web_firefox`.

`symbol_test` is gate D: it fails if the patch adds **any new top-level symbol** to the router
bundle. The patch deliberately declares its one helper *inside* `getInherited`, so no golden update
is needed. If you see

```
Symbol: hasNoOwnKeys => 1 missing in golden file.
```

the helper has been hoisted to module scope — a real finding, report it.

---

## 6. Gate B — the vulnerability

Bazel cannot show this. The harness below runs the real `packages/router/src` recognition path in
plain node, two arms side by side:

```
arm A = the base commit (unpatched)      arm C = HEAD (patched)
```

### 6.1 Build

Write **Appendix B** to `setup.sh`, then **from the repo root**:

```bash
bash setup.sh
cd /tmp/ng-70933-bench && source env.sh
```

It writes only to `$BENCH`. Confirm the repo is untouched:

```bash
git -C "$REPO" status --porcelain     # must print nothing
```

### 6.2 The four attack shapes

```bash
for arm in A C; do
  node --expose-gc drive.cjs  $arm query   480 1377
  node --expose-gc drive.cjs  $arm matrix  480 1377
  node --expose-gc drive.cjs  $arm outlets 480 0 2000
  node --expose-gc report.cjs $arm 670 1366
done
```

| Shape | URL | Isolates |
|---|---|---|
| `query` | `/shop/(480 outlets)?a&b&c…` | site 1 — **the URL in the filed issue** |
| `matrix` | `/shop;a;b;c…/(480 outlets)` | site 2 — **no query string at all** |
| `outlets … 2000` | `/shop/(480 outlets)`, route `data` 2000 keys | site 3 — no query, no matrix |
| `report.cjs` | `/shop;…/(670 outlets)` + a `modal` outlet route | sites 2+3, strongest shape |

Reference run. **Absolute ms is machine-dependent — judge the ratios.**

| Shape | bytes | snapshots | A: ms / heap | C: ms / heap |
|---|---:|---:|---:|---:|
| `query` | 7,873 | 1,926 | 843 ms / 99.3 MB | **48 ms / 2.8 MB** |
| `matrix` | 7,873 | 1,926 | 797 ms / 103.4 MB | **35 ms / 2.9 MB** |
| `data × outlets` | 3,794 | 1,926 | 1,939 ms / 99.2 MB | **31 ms / 3.4 MB** |
| report shape | 8,022 | 4,028 | 1,643 ms / 201.1 MB | **50 ms / 3.6 MB** |

**PASS =** for all four shapes, arm C is **≥ 10× faster and uses ≥ 10× less heap** than arm A, and
arm C is under 150 ms / 15 MB absolute.

**Snapshot counts must be identical between arms.** The patch reduces the *width* of each snapshot,
not how many are built. Fewer snapshots on arm C means you have an unscoped version of the patch.

### 6.3 Gate B′ — the counterfactual (the important one)

Build a third arm that applies **only** the `queryParams` fix — what a narrower patch would do:

```bash
cd "$BENCH" && source env.sh
rm -rf srcB && mkdir -p srcB && cp -r "$BENCH/srcA/packages" "$BENCH/srcB/packages"

python3 - "$BENCH/srcB/packages/router/src/recognize.ts" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "  private absoluteRedirectCount = 0;\n  allowRedirects = true;\n"
assert s.count(old) == 1
s = s.replace(old, old + "\n  private queryParams!: Params;\n")
old = "    this.applyRedirects = new ApplyRedirects(this.urlSerializer, this.urlTree);\n"
assert s.count(old) == 1
s = s.replace(old, old + "    this.queryParams = Object.freeze({...this.urlTree.queryParams});\n")
old = "      if (e instanceof AbsoluteRedirect) {\n        this.urlTree = e.urlTree;\n"
assert s.count(old) == 1
s = s.replace(old, old + "        this.queryParams = Object.freeze({...this.urlTree.queryParams});\n")
old = "      Object.freeze({...this.urlTree.queryParams}),\n"
assert s.count(old) == 2
s = s.replace(old, "      this.queryParams,\n")
open(p, "w").write(s)
print("arm B: queryParams-only")
PY

cat > "$BENCH/entry-B.ts" <<EOF
import {DefaultUrlSerializer} from '$BENCH/srcB/packages/router/src/url_tree';
import {recognize, Recognizer} from '$BENCH/srcB/packages/router/src/recognize';
(globalThis as any).__harness = {DefaultUrlSerializer, recognize, Recognizer};
EOF

"$ESBUILD" entry-B.ts --bundle --format=cjs --platform=node \
  --tsconfig="$REPO/packages/tsconfig.json" --define:ngDevMode=false \
  --alias:@angular/core/primitives/signals=./stub-signals.cjs \
  --alias:@angular/core=./stub-core.cjs --outfile=bundle-B.cjs

node --expose-gc drive.cjs B query  480 1377
node --expose-gc drive.cjs B matrix 480 1377
```

Expected, and this is the whole point of the exercise:

```
B query  →   40 ms /  4.8 MB    fixed
B matrix →  803 ms / 95.0 MB    UNCHANGED from arm A
```

**PASS =** arm B fixes `query` and does **not** fix `matrix`.

If arm B also fixes `matrix`, the patch's central justification is wrong — say so loudly. That is
the single most valuable thing you can find here.

> Note on the arm-B source edit: the field is declared and assigned in the constructor **body**, not
> as an initializer. An initializer reading `this.urlTree` fails to compile under
> `packages/tsconfig-build.json` (`target: es2022`, so `useDefineForClassFields` defaults to `true`)
> with `TS2729: Property 'urlTree' is used before its initialization`. The counterfactual is built
> in its strongest working form on purpose.

### 6.4 Gate B″ — the OOM sweep

The standalone harness holds no SSR app, so a single request will not exhaust a worker the way a
real server does — that is expected. Use concurrency, which is what an async `canMatch` guard hands
an attacker:

```bash
for arm in A B C; do
  for w in query matrix; do
    line=""
    for c in 1 2 3 4 5 6 7 8; do
      if GUARD_MS=25 CONC=$c node --max-old-space-size=128 drive.cjs $arm $w 480 1377 >/dev/null 2>&1
      then line="$line ok"; else line="$line DEAD"; fi
    done
    printf "%-2s %-7s%s\n" $arm $w "$line"
  done
done
```

Expected (takes a few minutes; `Aborted` on stderr is the V8 OOM and is the point):

```
A  query    ok DEAD DEAD DEAD DEAD DEAD DEAD DEAD
A  matrix   ok DEAD DEAD DEAD DEAD DEAD DEAD DEAD
B  query    ok ok   ok   ok   ok   ok   ok   ok
B  matrix   ok DEAD DEAD DEAD DEAD DEAD DEAD DEAD     <- the gap
C  query    ok ok   ok   ok   ok   ok   ok   ok
C  matrix   ok ok   ok   ok   ok   ok   ok   ok
```

**PASS =** arm C survives all 8 on both shapes, and arm A dies at concurrency ≤ 2 on both.

---

## 7. Gate C — behaviour

Sharing an object is only safe if nothing observes the difference. Check identity, frozenness and
values together:

```bash
cat > "$BENCH/identity.cjs" <<'EOF'
globalThis.ngDevMode = false;
const arm = process.argv[2];
require(`./bundle-${arm}.cjs`);
const {DefaultUrlSerializer, recognize} = globalThis.__harness;
const routes = [{path: 'shop', children: [{path: '', children: [
  {path: '', component: class {}},
  {path: '', outlet: 'modal', component: class {}},
]}]}];
(async () => {
  const s = new DefaultUrlSerializer();
  const {state} = await recognize({get: (t, nf) => nf}, {}, null, routes,
    s.parse('/shop;x=1;y=2/(modal:/())'), s, 'emptyOnly', new AbortController().signal);
  const shop = state._root.children[0].value;
  const out = []; (function w(n){ out.push(n.value); n.children.forEach(w); })(state._root);
  for (const v of out.slice(2)) {
    console.log(`${arm} outlet=${v.outlet.padEnd(8)} shared=${v.params === shop.params}` +
      ` frozen=${Object.isFrozen(v.params)} values=${JSON.stringify(v.params)}`);
  }
})();
EOF
for arm in A B C; do node "$BENCH/identity.cjs" $arm; done
```

Expected:

```
A outlet=primary  shared=false frozen=true values={"x":"1","y":"2"}
A outlet=primary  shared=false frozen=true values={"x":"1","y":"2"}
A outlet=modal    shared=false frozen=true values={"x":"1","y":"2"}
B outlet=primary  shared=false frozen=true values={"x":"1","y":"2"}
B outlet=primary  shared=false frozen=true values={"x":"1","y":"2"}
B outlet=modal    shared=false frozen=true values={"x":"1","y":"2"}
C outlet=primary  shared=true  frozen=true values={"x":"1","y":"2"}
C outlet=primary  shared=true  frozen=true values={"x":"1","y":"2"}
C outlet=modal    shared=true  frozen=true values={"x":"1","y":"2"}
```

**PASS =** arm C reports `shared=true frozen=true` everywhere, with **the same values** as arm A.
Values differing between arms is a behaviour regression — report it.

### 7.1 Do the tests actually test anything?

Revert only the two source files, keep the spec, and re-run:

```bash
cd "$REPO"
git checkout 846c73d52be8104aea826da5d4d95814fd24b117 -- \
  packages/router/src/recognize.ts packages/router/src/router_state.ts
node_modules/.bin/bazelisk test //packages/router/test:test 2>&1 | tail -25
git checkout HEAD -- packages/router/src
git status --porcelain      # must print nothing
```

**PASS =** the suite FAILS with exactly these three, all in `describe('snapshot creation')`:

```
1) reads a route data object once per snapshot rather than once per inheritor
     Expected $.length = 6 to equal 2.
2) shares one queryParams object across every snapshot
3) shares the parent params and data with a route that adds none of its own
```

The fourth spec, `copies, rather than shares, when the route contributes params or data`, is
behaviour preservation and correctly passes on both. A patch whose tests all pass without the patch
is not tested.

---

## 8. Pitfalls that will cost you an hour

- **`bazel` vs `bazelisk`.** Use `node_modules/.bin/bazelisk`. A system `bazel` gives stale results.
- **esbuild must be run as the binary**, not `node …/bin/esbuild` — it is a shell shim.
- **`--expose-gc` is required** or the heap deltas mean nothing.
- **Never instrument with `Object.keys(o).length`.** It is O(width) on a dictionary-mode object and
  will become most of your profile — and it silently re-creates the very product term you are
  measuring. The harness counts with an O(1) increment; keep it that way.
- **Alphabetic keys only.** Numeric parameter names measure a *different*, already-fixed bug
  (#70717's `setUrlDerivedKey` elements guard, which only acts on `Number(key) >= 32`). That guard
  fires **0 times** on this attack; you can confirm by wrapping `Object.hasOwn` and counting calls
  with the key `0x40000000`.
- **A single request will not OOM the standalone harness.** Expected. Use §6.4.
- **`Aborted` lines on stderr during §6.4 are the result**, not an error in your setup.

---

## 9. What to report

```
GATE A  (bazel router)        PASS/FAIL   <n>/17 targets
GATE D  (symbol golden)       PASS/FAIL
GATE B  (attacks closed)      PASS/FAIL   ratio per shape, all four
GATE B' (counterfactual)      PASS/FAIL   does queryParams-only leave `matrix` alive?
GATE B" (OOM sweep)           PASS/FAIL   first fatal concurrency per arm
GATE C  (behaviour)           PASS/FAIL   shared / frozen / values
GATE C.1 (tests discriminate) PASS/FAIL   which specs fail on reverted src
FILES TOUCHED                 <list>      must be exactly 3
MACHINE                       os / cpu / node version
```

Plus anything you found that is not in this document. Negative results are results: if the
counterfactual in §6.3 does **not** reproduce, that is the most important finding and it should
lead your report.

---

## Appendices

Appendix A, the patch itself, is saved next to this file as `70933.patch` so it can be
applied directly with `git apply --index 70933.patch` instead of being copied out of a
fenced block. It carries the two source hunks. The spec additions in
`packages/router/test/recognize.spec.ts` add a `describe("snapshot creation")` block with
four tests plus a `collectSnapshots` helper; see section 7.1 for which three must fail on
reverted sources.

Appendix B, `setup.sh`, is not saved here. It only runs inside an angular/angular checkout
(it needs `git archive`, the repo tsconfig and the repo esbuild), and this repository has
no such checkout. It lives with whoever is running the monorepo side.
