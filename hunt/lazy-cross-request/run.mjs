import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const appRoot = path.resolve(process.argv[2] ?? 'hunt-app');
const mode = process.argv[3] ?? 'static';
const version = process.argv[4] ?? 'unknown';
const trials = Number(process.env.TRIALS ?? 5);
const outDir = path.resolve(process.env.OUT_DIR ?? 'hunt-results');
await mkdir(outDir, {recursive: true});

const serverEntry = path.join(appRoot, 'dist/router-oom-e2e/server/server.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    const started = performance.now();
    const response = await fetch(url, {...init, signal: controller.signal});
    const text = await response.text();
    return {
      status: response.status,
      text,
      elapsedMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractLine(body, prefix) {
  const normalized = body.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  const index = normalized.indexOf(prefix);
  if (index === -1) return null;
  const tail = normalized.slice(index);
  const end = tail.search(/<|\n/);
  return (end === -1 ? tail : tail.slice(0, end)).trim();
}

function parseFields(line) {
  if (!line) return null;
  const fields = {};
  for (const item of line.split('|').slice(1)) {
    const equal = item.indexOf('=');
    if (equal === -1) continue;
    fields[item.slice(0, equal)] = item.slice(equal + 1);
  }
  return fields;
}

async function waitReady(baseUrl, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const health = await fetchWithTimeout(`${baseUrl}/__health`, {}, 1000);
      if (health.status === 200 && health.text === 'ok') return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not become ready');
}

async function request(baseUrl, pathname, marker) {
  const result = await fetchWithTimeout(
    `${baseUrl}${pathname}`,
    {
      headers: {
        'x-probe-marker': marker,
        cookie: `probe=${marker}`,
      },
    },
    15000,
  );
  const line = extractLine(result.text, pathname.startsWith('/lazy') ? 'PROBE|' : 'CONTROL|');
  return {...result, line, fields: parseFields(line)};
}

async function runTrial(trial) {
  const port = 4300 + trial;
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=512', serverEntry],
    {
      cwd: appRoot,
      env: {...process.env, PORT: String(port), NODE_ENV: 'production'},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => logs.push(`STDOUT ${chunk}`));
  child.stderr.on('data', (chunk) => logs.push(`STDERR ${chunk}`));

  try {
    await waitReady(baseUrl, child);
    const controlA = await request(baseUrl, '/control?marker=A', 'A');
    const first = await request(baseUrl, '/lazy?marker=A', 'A');
    await sleep(250);
    const afterFirst = await fetchWithTimeout(`${baseUrl}/__metrics`);
    const controlB = await request(baseUrl, '/control?marker=B', 'B');
    const second = await request(baseUrl, '/lazy?marker=B', 'B');
    await sleep(250);
    const third = await request(baseUrl, '/lazy?marker=C', 'C');
    await sleep(250);
    const finalMetricsRaw = await fetchWithTimeout(`${baseUrl}/__metrics`);
    const health = await fetchWithTimeout(`${baseUrl}/__health`);
    let afterFirstMetrics = null;
    let finalMetrics = null;
    try { afterFirstMetrics = JSON.parse(afterFirst.text); } catch {}
    try { finalMetrics = JSON.parse(finalMetricsRaw.text); } catch {}

    return {
      trial,
      mode,
      version,
      controlA,
      first,
      afterFirstMetrics,
      controlB,
      second,
      third,
      finalMetrics,
      health,
      process: {exitCode: child.exitCode, signalCode: child.signalCode},
      logs,
    };
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(3000).then(() => child.kill('SIGKILL')),
    ]);
  }
}

const results = [];
for (let trial = 0; trial < trials; trial++) {
  try {
    results.push(await runTrial(trial));
  } catch (error) {
    results.push({trial, mode, version, fatal: String(error?.stack ?? error)});
  }
}

function classify(entry) {
  if (entry.fatal) return {fatal: true};
  const a = entry.first.fields;
  const b = entry.second.fields;
  const c = entry.third.fields;
  const controlFresh =
    entry.controlA.fields?.marker === 'A' &&
    entry.controlB.fields?.marker === 'B';
  const sharedService = Boolean(a && b && a.service === b.service && Number(b.hit) > Number(a.hit));
  const staleCaptured = Boolean(b && b.capturedMarker === 'A');
  const staleDirect = Boolean(b && b.directMarker === 'A');
  const thirdStale = Boolean(c && c.capturedMarker !== 'C');
  return {
    controlFresh,
    sharedService,
    staleCaptured,
    staleDirect,
    thirdStale,
    statuses: [entry.first.status, entry.second.status, entry.third.status],
    first: a,
    second: b,
    third: c,
    metrics: entry.finalMetrics,
  };
}

const classifications = results.map(classify);
const summary = {
  mode,
  version,
  trials,
  classifications,
  counts: {
    fatal: classifications.filter((x) => x.fatal).length,
    controlFresh: classifications.filter((x) => x.controlFresh).length,
    sharedService: classifications.filter((x) => x.sharedService).length,
    staleCaptured: classifications.filter((x) => x.staleCaptured).length,
    staleDirect: classifications.filter((x) => x.staleDirect).length,
    thirdStale: classifications.filter((x) => x.thirdStale).length,
  },
};

const artifact = {summary, results};
const output = path.join(outDir, `lazy-cross-request-${version}-${mode}.json`);
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
console.log(`RESULT_FILE=${output}`);
