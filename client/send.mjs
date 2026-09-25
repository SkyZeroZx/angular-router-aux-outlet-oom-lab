import http from "node:http";
import { buildTarget } from "./workloads.mjs";

const target = new URL(process.env.TARGET_URL ?? "http://127.0.0.1:4000");
const REQUEST_TIMEOUT_MS = 300_000;

// shop  the plain two-level empty-path group; one request is enough
// guard  the same shape behind an async canMatch guard; concurrency compounds
const shape = process.env.SHAPE ?? "shop";
const mode = process.env.MODE ?? "candidate";
const concurrency = Number(process.env.CONCURRENCY ?? "1");
const outletCount = Number(process.env.OUTLETS ?? "480");
const queryNames = Number(process.env.QUERY_NAMES ?? "1377");

if (!["shop", "guard"].includes(shape)) {
  throw new Error(`Unsupported SHAPE=${shape}. Expected "shop" or "guard".`);
}
if (!["candidate", "control"].includes(mode)) {
  throw new Error(`Unsupported MODE=${mode}. Expected "candidate" or "control".`);
}

const path = buildTarget({ shape, mode, outletCount, queryNames });
const pathBytes = Buffer.byteLength(path);

console.log(
  JSON.stringify({
    shape,
    mode,
    concurrency,
    outlets: outletCount,
    queryNames,
    distinctQueryNames: mode === "candidate" ? queryNames : 2,
    pathBytes,
    // Node's own default header budget is 16 KiB, so this needs no tuning.
    requestLineBytes: pathBytes + "GET  HTTP/1.1\r\n".length,
    heapMb: Number(process.env.HEAP_MB ?? "0") || undefined,
    canMatchMs: Number(process.env.CANMATCH_MS ?? "0") || undefined,
    destination: target.origin,
  }),
);

function request(index) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A socket of its own per request, so the concurrency is real.
    const req = http.get(
      {
        host: target.hostname,
        port: target.port,
        path,
        timeout: REQUEST_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => (bytes += chunk.length));
        res.on("end", () =>
          resolve({ index, status: res.statusCode, bytes, ms: Date.now() - started }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ index, error: "timeout", ms: Date.now() - started });
    });
    req.on("error", (error) =>
      resolve({ index, error: error.code ?? error.message, ms: Date.now() - started }),
    );
  });
}

const results = await Promise.all(
  Array.from({ length: concurrency }, (_, index) => request(index)),
);

console.log(JSON.stringify({ shape, mode, concurrency, results }));
