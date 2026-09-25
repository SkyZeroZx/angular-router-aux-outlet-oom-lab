import http from "node:http";
import { createHash } from "node:crypto";
import { buildTarget } from "./workloads.mjs";

const target = new URL(process.env.TARGET_URL ?? "http://127.0.0.1:4000");
const REQUEST_TIMEOUT_MS = 300_000;

// shop   the plain two-level empty-path group; one request is enough
// shop1  the same thing with one empty-path level, for the depth comparison
// shop3  three levels, shop4 four, to measure what depth is worth
// layout the two-level shape with a component on the outer level
// aux    a pathless layout with a default page and an empty named modal route
// guard3, guard4  the guarded shape at three and four levels
// guard  the same shape behind an async canMatch guard; concurrency compounds
const shape = process.env.SHAPE ?? "shop";
const mode = process.env.MODE ?? "candidate";
const concurrency = Number(process.env.CONCURRENCY ?? "1");
const outletCount = Number(process.env.OUTLETS ?? "480");
const queryNames = Number(process.env.QUERY_NAMES ?? "1377");
// Matrix parameters on the first segment. The /aux shape is what makes them cost.
const matrixNames = Number(process.env.MATRIX_NAMES ?? "0");

// Recognition ends on a redirect to the merged URL, so the rendered body is one
// hop away. Following it is how the arms are compared for identical output, and
// it is off by default: a second request per arm would change what the
// concurrency arms measure.
const follow = process.env.FOLLOW === "1";

const SHAPES = ["shop", "shop1", "shop3", "shop4", "layout", "aux", "auxguard", "guard", "guard3", "guard4"];
if (!SHAPES.includes(shape)) {
  throw new Error(`Unsupported SHAPE=${shape}. Expected one of ${SHAPES.join(", ")}.`);
}
if (!["candidate", "control"].includes(mode)) {
  throw new Error(`Unsupported MODE=${mode}. Expected "candidate" or "control".`);
}

const path = buildTarget({ shape, mode, outletCount, queryNames, matrixNames });
const pathBytes = Buffer.byteLength(path);

console.log(
  JSON.stringify({
    shape,
    mode,
    concurrency,
    outlets: outletCount,
    queryNames,
    matrixNames,
    distinctQueryNames: mode === "candidate" ? queryNames : 2,
    pathBytes,
    // Node's own default header budget is 16 KiB, so this needs no tuning.
    requestLineBytes: pathBytes + "GET  HTTP/1.1\r\n".length,
    heapMb: Number(process.env.HEAP_MB ?? "0") || undefined,
    canMatchMs: process.env.CANMATCH_MS,
    follow,
    destination: target.origin,
  }),
);

function get(requestPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const hash = createHash("sha256");
    // A socket of its own per request, so the concurrency is real.
    const req = http.get(
      {
        host: target.hostname,
        port: target.port,
        path: requestPath,
        timeout: REQUEST_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            bytes,
            sha256: hash.digest("hex"),
            locationBytes: res.headers.location
              ? Buffer.byteLength(res.headers.location)
              : undefined,
            _location: res.headers.location,
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout", ms: Date.now() - started });
    });
    req.on("error", (error) =>
      resolve({ error: error.code ?? error.message, ms: Date.now() - started }),
    );
  });
}

async function request(index) {
  const { _location, ...first } = await get(path);
  const redirected = first.status >= 300 && first.status < 400;
  if (!follow || !_location || !redirected) {
    return { index, ...first };
  }
  // The Location echoes the merged URL, so the hop is the same order of
  // magnitude as the request that produced it.
  const hop = new URL(_location, target);
  const { _location: _drop, ...followed } = await get(hop.pathname + hop.search);
  return { index, ...first, followed };
}

const results = await Promise.all(
  Array.from({ length: concurrency }, (_, index) => request(index)),
);

console.log(JSON.stringify({ shape, mode, concurrency, results }));
