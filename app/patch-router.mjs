// Proof-only edits to @angular/router, applied at image build time by the
// ROUTER_PATCH build arg. "none" leaves the package stock, which is what the
// validate script and every headline number use.
//
//   share-query  create and freeze the query map once per recognition attempt
//                and share it, instead of copying it into every snapshot
//   count        report how many snapshots a request builds and how many query
//                properties they copy, one line per burst in the app log
//
// And the candidate fix itself, which is not proof-only. See router-fix.mjs.
//
//   fix          the candidate fix from the validation task: shared frozen query
//                map, shared inherited params and data, lazy resolve. router-fix.mjs
//                has the detail.
//   fix-count    the same with the counters on top, to show what it removed
import { readFileSync, writeFileSync } from "node:fs";
import { applyFix, FIXED_SNAPSHOT_ANCHOR } from "./router-fix.mjs";

const FILE = "node_modules/@angular/router/fesm2022/_router-chunk.mjs";

// Recognizer.createSnapshot(), verbatim from @angular/router 22.2.0.
const ANCHOR = `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, Object.freeze({
      ...this.urlTree.queryParams
    }), this.urlTree.fragment,`;

const PATCHES = {
  "share-query": ANCHOR.replace(
    "Object.freeze({\n      ...this.urlTree.queryParams\n    })",
    "(this.__shared ??= Object.freeze({\n      ...this.urlTree.queryParams\n    }))",
  ),
  // The key count is resolved once per recognition, so counting does not itself
  // allocate per snapshot. One debounced line per request burst.
  count: `    this.__n ??= Object.keys(this.urlTree.queryParams).length;
    globalThis.__s = (globalThis.__s ?? 0) + 1;
    globalThis.__k = (globalThis.__k ?? 0) + this.__n;
    clearTimeout(globalThis.__t);
    globalThis.__t = setTimeout(() => {
      console.log(JSON.stringify(
        { snapshots: globalThis.__s, queryKeysCopied: globalThis.__k }));
      // Reset, so each line is the burst that produced it rather than every
      // request the worker has served since it booted.
      globalThis.__s = 0;
      globalThis.__k = 0;
    }, 250);
${ANCHOR}`,
};

const MODES = [...Object.keys(PATCHES), "fix", "fix-count"];
// On the stock bundle every snapshot copies the map, so counting keys per
// snapshot is counting copies. After the fix the map is copied once per
// recognition attempt, so the snapshot counter and the copy counter have to sit
// in different places or the number would be keys REFERENCED, not copied.
const countersFixedSnapshot = "    globalThis.__s = (globalThis.__s ?? 0) + 1;\n    clearTimeout(globalThis.__t);\n    globalThis.__t = setTimeout(() => {\n      console.log(JSON.stringify(\n        { snapshots: globalThis.__s, queryKeysCopied: globalThis.__k ?? 0 }));\n      globalThis.__s = 0;\n      globalThis.__k = 0;\n    }, 250);\n";

// The one place the fix actually spreads the map.
const FIXED_COPY_ANCHOR = "      this.frozenQueryParamsSource = this.urlTree.queryParams;";
const countersFixedCopy = [
  FIXED_COPY_ANCHOR,
  "      globalThis.__k = (globalThis.__k ?? 0) + Object.keys(this.urlTree.queryParams).length;",
].join("\n");

const mode = process.argv[2] ?? "none";
if (mode === "none") process.exit(0);
if (!MODES.includes(mode)) {
  throw new Error(`Unsupported ROUTER_PATCH=${mode}. Expected none or one of ${MODES.join(", ")}.`);
}

const source = readFileSync(FILE, "utf8");

if (mode === "fix" || mode === "fix-count") {
  let out = applyFix(source);
  if (mode === "fix-count") {
    // The fix rewrote createSnapshot, so the counters anchor on its new shape and
    // read the shared map rather than urlTree.queryParams.
    if (!out.includes(FIXED_SNAPSHOT_ANCHOR)) {
      throw new Error("the fixed createSnapshot() is not where router-fix.mjs said it would be.");
    }
    out = out.replace(
      FIXED_SNAPSHOT_ANCHOR,
      `${countersFixedSnapshot}${FIXED_SNAPSHOT_ANCHOR}`,
    );
    if (!out.includes(FIXED_COPY_ANCHOR)) {
      throw new Error("the fix's queryParams getter is not where router-fix.mjs said it would be.");
    }
    out = out.replace(FIXED_COPY_ANCHOR, countersFixedCopy);
  }
  writeFileSync(FILE, out);
  console.log(`applied ROUTER_PATCH=${mode}`);
  process.exit(0);
}

if (!source.includes(ANCHOR)) {
  throw new Error("createSnapshot() no longer matches the expected source; the anchor needs updating.");
}

writeFileSync(FILE, source.replace(ANCHOR, PATCHES[mode]));
console.log(`applied ROUTER_PATCH=${mode}`);
