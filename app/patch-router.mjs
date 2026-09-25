// Proof-only edits to @angular/router, applied at image build time by the
// ROUTER_PATCH build arg. "none" leaves the package stock, which is what the
// validate script and every headline number use.
//
//   share-query  create and freeze the query map once per recognition attempt
//                and share it, instead of copying it into every snapshot
//   count        report how many snapshots a request builds and how many query
//                properties they copy, one line per request in the app log
import { readFileSync, writeFileSync } from "node:fs";

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

const mode = process.argv[2] ?? "none";
if (mode === "none") process.exit(0);
if (!Object.hasOwn(PATCHES, mode)) {
  throw new Error(`Unsupported ROUTER_PATCH=${mode}. Expected none, ${Object.keys(PATCHES).join(" or ")}.`);
}

const source = readFileSync(FILE, "utf8");
if (!source.includes(ANCHOR)) {
  throw new Error("createSnapshot() no longer matches the expected source; the anchor needs updating.");
}

writeFileSync(FILE, source.replace(ANCHOR, PATCHES[mode]));
console.log(`applied ROUTER_PATCH=${mode}`);
