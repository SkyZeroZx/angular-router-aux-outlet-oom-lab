# Angular Router auxiliary-outlet SSR OOM

Minimal reproduction of an Angular Router out-of-memory failure during
server-side rendering. This file holds the methodology and the numbers behind it.

```text
Candidate: /shop/(a:/()//b:/()//...)?a&b&c&d&...   480 outlets, 1,377 names
Control:   /shop/(a:/()//b:/()//...)?a&a&a&a&...   480 outlets,     2 names
```

Both URLs are the same 7,873 bytes, declare the same outlets and carry the same
query pairs. They differ only in how many *distinct* names the query map ends up
with. One candidate request exhausts a 128 MiB SSR worker. The control answers and
the worker stays up.

The URL pays for the outlets and the names once each. The Router pays for their
product: **1,926 snapshots and 2,652,102 query-property copies**, before anything
is merged or rendered.

Nothing here is numeric, so this is not the matrix-parameter family
[#70716](https://github.com/angular/angular/issues/70716) /
[#70717](https://github.com/angular/angular/pull/70717) fixed. It reproduces on
22.2.0, the release that carries that fix.

## Where it comes from

`@angular/router` 22.2.0, `fesm2022/_router-chunk.mjs`:

| site | line | what |
| ---- | ---: | ---- |
| `processChildren()` | n/a | recognises every child outlet, then calls `mergeEmptyPathMatches()` after the loop |
| `match()` | 2905 | lets an empty-path route match consuming nothing, for outlets it was not configured for |
| `createSnapshot()` | 3160 | `Object.freeze({...this.urlTree.queryParams})` per snapshot |
| `matchWithChecks()` | 2898 | a second, pre-match snapshot per attempt. The only early return above it is `if (!result.matched)` |

Snapshots are `2(D + 1) + 2 x D x O` for `D` empty-path levels and `O` outlets.

## Automated test

```bash
./scripts/validate.sh shop
```

```text
== shop | heap 128 MiB | 480 outlets | 1 request ==
[PASS] control: worker survived.
[PASS] candidate: V8 heap limit reached, worker gone, OOMKilled=false.
```

`OOMKilled=false` separates V8 reaching `--max-old-space-size` from the kernel
reaping the container. `mem_limit` is set well above the V8 limit so the two cannot
be confused. Each trial also checks the worker's own command line first, because a
container reused at the wrong heap looks exactly like a result.

Every table below is one arm of the same script, and each arm writes its logs into
`evidence/`. `TRIALS` sets how many fresh workers a repeated arm uses, five by
default.

```bash
./scripts/validate.sh arms      # both dimensions, then each alone, 128 MiB
./scripts/validate.sh diff      # the same four arms where none of them die
./scripts/validate.sh counts    # snapshots and query copies, per depth
./scripts/validate.sh aux       # matrix-param width against a named modal outlet
./scripts/validate.sh ablation  # stock against the shared-query-map edit
./scripts/validate.sh fuzz      # splits one request-line budget between the two
./scripts/validate.sh guard     # the async canMatch sweep
./scripts/validate.sh gdepth    # the guarded column by empty-path depth
./scripts/validate.sh matrix    # four heaps and both sizes, through Nginx
./scripts/validate.sh fixcheck  # the candidate fix, end to end
```

Peak memory is the container's own monotonic cgroup counter, polled at 20 Hz. On an
arm that dies it is a floor and not a peak, because the container takes the counter
with it. That is why the differential is read off `diff`, where nothing dies.

Recognition ends on a redirect to the merged URL, so the rendered page is one hop
past the measured request. `FOLLOW=1` takes that hop and hashes what comes back. It
is off by default, because a second request per arm would change what the
concurrency arms measure.

## The four arms

128 MiB, one request, five fresh workers per arm.

| Arm | Outlets | Names | Bytes | Outcome | Snapshots | Keys copied |
| --- | ------: | ----: | ----: | ------- | --------: | ----------: |
| Candidate | 480 | 1,377 | 7,873 | **5/5 fatal** | 1,926 | **2,652,102** |
| Control, equal bytes | 480 | 2 | 7,873 | 0/5 fatal | 1,926 | 3,852 |
| Query width only | 0 | 1,377 | 4,084 | 0/5 fatal | 6 | 8,262 |
| Outlet fan-out only | 480 | 0 | 3,794 | 0/5 fatal | 1,926 | 0 |

All four return the same 328-byte body, SHA-256 `a362f24f…`. At 256 MiB nothing
dies and the differential is readable: candidate 851 ms / 224 MiB, control
171 ms / 90 MiB, query-only 160 ms / 71 MiB, outlet-only 141 ms / 73 MiB.

Depth, same request, `ROUTER_PATCH=count`:

| levels | snapshots | keys copied |
| -----: | --------: | ----------: |
| 1 | 964 | 1,327,428 |
| 2 | 1,926 | 2,652,102 |

At 100 outlets the series is 204 / 406 / 608 / 810 for one through four levels.
Linear, with no saturation. `/layout` is the two-level shape with a component on
the outer level instead of a componentless one, and it builds the same 406. The
precondition is any empty-path level with children.

## The async canMatch guard

`/guard` is the same shape with an async `canMatch` on the outer empty-path level.
It is the only place recognition yields the event loop, so concurrent requests
overlap their speculative trees.

```bash
./scripts/validate.sh guard
```

120 outlets at 128 MiB, so one request is not already fatal and concurrency is the
variable:

```text
canMatch   requests to OOM    control at that count
0 ms       4                  4/4 survived
100 ms     4                  4/4 survived
250 ms     4                  4/4 survived
500 ms     4                  4/4 survived
```

The delay does not move the count. What matters is that the guard is async at all.

The guard runs once per URL outlet, not once per request, so its per-check delay
multiplies by the outlet count. 500 ms against 480 outlets is four minutes of wall
clock for one request. That is why this arm uses 120.

## Through Nginx

Both request-line sizes, four heaps, with and without the guard.

```bash
./scripts/validate.sh matrix
```

| Request line | Heap | No guard | Async canMatch |
| -----------: | ---: | -------: | -------------: |
| 7,888 B | 128 MiB | **1** | **1** |
| | 256 MiB | survives 16 | **2** |
| | 512 MiB | survives 16 | **5** |
| | 1,024 MiB | survives 16 | between 6 and 16 |
| 16,255 B | 128 MiB | **1** | **1** |
| | 256 MiB | **1** | **1** |
| | 512 MiB | survives 16 | **2** |
| | 1,024 MiB | survives 16 | **4** |

A bare number is the lowest concurrency that lost the worker. `survives 16` means
sixteen concurrent requests left it healthy. The ramp probes its ceiling first, so
a cell that survives the ceiling costs one measurement instead of a full climb. The
exact count at a boundary moves by one between runs, so treat these as the boundary
to within a request.

Two Nginx settings are not defaults. `large_client_header_buffers 4 16k` is the AWS
Elastic Load Balancer request line, on the request path. `proxy_buffer_size` is on
the response path. Recognition ends on a redirect whose `Location` echoes the
merged URL, measured at 5,461 bytes for the 8 KiB payload and 10,857 for the 16 KiB
one, and at Nginx's one-page default every proxied response comes back 502 with
"upstream sent too big header" instead of the app's own status. With it raised, a
surviving trial answers 302 and a fatal one answers 502 because the upstream is
gone, so the per-request status becomes an independent signal.

Neither size needs anything tuned to be accepted. 7,888 bytes fits Node's default
16 KiB header budget on its own, and 16,255 still fits it once Nginx has added
`Host` and the `X-Forwarded-*` headers. Past that Node answers 431.

The same grid by depth, published payloads:

```bash
./scripts/validate.sh gdepth
```

| Request line | Heap | 2 levels | 3 levels | 4 levels |
| -----------: | ---: | ---------------: | -------: | -------: |
| 7,888 B | 256 MiB | 2 | 2 | **1** |
| | 512 MiB | 5 | **3** | **3** |
| | 1,024 MiB | between 6 and 16 | **6** | **5** |
| 16,255 B | 256 MiB | 1 | 1 | 1 |
| | 512 MiB | 2 | 2 | **1** |
| | 1,024 MiB | 4 | **3** | **2** |

More guards on the same route change nothing. `runCanMatchGuards()` builds one
pre-match snapshot and hands the same object to every guard in the array, and
`prioritizedGuardValue()` waits for the slowest of them, not for their sum. Guards
on more than one level should compound. This repository does not measure that.

## What the budget buys

Snapshots are linear in the outlet count. Per-snapshot cost is a staircase in the
name count, because V8 pre-sizes the dictionary to `nextPow2(N + N/2)` at 24 bytes
a slot. Measured by heap delta over 400 live copies, and confirmed with
`%DebugPrint`:

| distinct names | bytes per copy | representation |
| -------------: | -------------: | -------------- |
| up to 1,020 | ~8.5 per name | fast properties, descriptors shared across copies |
| 1,021 - 1,365 | 49,323 | dictionary, capacity 2,048 |
| 1,366 - 2,731 | 98,475 | capacity 4,096 |
| 2,732 - 5,461 | 196,779 | capacity 8,192 |

One extra name at 1,021 multiplies per-snapshot cost by about six. That is V8's
`kMaxNumberOfDescriptors` of 1,020. The efficient name counts are the *smallest* on
each step, since anything above pays URL bytes for capacity it already had.

The `//` between outlets is optional and does not change the fan-out: 406 snapshots
at 100 outlets either way, so about two bytes per outlet for free. The four
characters of `:/()` are not optional. Measured with `ROUTER_PATCH=count` at 100
outlets:

| spelling | snapshots |
| -------- | --------: |
| `name:/()` | 406 |
| `name:/` | 12 |
| `name:z` | 12 |
| `name:()` | fails to parse |
| `name:` | folds four outlets into two children |

The empty `()` child group is what lets an empty-path route match an outlet while
consuming nothing. Without it recognition never fans out.

```bash
./scripts/validate.sh fuzz
```

Applying both levers moves the 16 KiB arm across a heap it used to survive, at a
request line four bytes shorter:

| payload | request line | snapshots | at 512 MiB |
| ------- | -----------: | --------: | ---------- |
| 1,020 x 2,726, separators | 16,255 B | 4,086 | 0/3 fatal, 321 MiB |
| 1,356 x 2,726, no separators | 16,233 B | 5,430 | 0/3 fatal, 395 MiB |
| **1,356 x 2,732, no separators** | **16,251 B** | **5,430** | **5/5 fatal**, 605 MiB |

Neither lever is enough alone. The last two rows differ by six names and 18 bytes,
which is the whole distance between capacity 4,096 and 8,192. The 8 KiB arm has no
such headroom: capacity 8,192 needs 8,144 bytes of names by itself, more than its
whole 7,873-byte path budget, so it is capped at capacity 4,096 by arithmetic.

Largest heap one request kills, no guard, best payload for each request line:

| empty-path levels | 7,887 B | 16,251 B |
| ----------------- | ------: | -------: |
| 1 | survives 128 MiB | 256 MiB |
| 2 | 128 MiB | 512 MiB |
| 3 | 128 MiB | 512 MiB |
| 4 | **256 MiB** | **1,024 MiB** |

The peak grows sublinearly with depth even though the snapshot count does not. At
256 MiB the 8 KiB payload peaked 218.6, 275.6 and 309.8 MiB at two, three and four
levels, where the count grew 1.0x, 1.5x and 2.0x.

## The matrix-parameter shape

The same fan-out reaches a second copy site, and that one needs no query string.
`getInherited()` builds `{...parent.params, ...route.params}` for every snapshot,
and the condition `routeConfig?.path === ''` makes every empty-path route take
that branch. So matrix parameters on the consumed segment are copied once per
snapshot, exactly as the query map is.

`/aux` is a pathless layout holding a default page and an empty named modal
route. Two empty-path children at the inner level instead of one, so recognition
builds six snapshots per URL outlet instead of four:

```ts
{
  path: "aux",
  children: [
    {
      path: "",
      component: AuxLayout,
      children: [
        {path: "", component: ShopPage},
        {path: "", outlet: "modal", component: ModalPage},
      ],
    },
  ],
}
```

Measured with `ROUTER_PATCH=count`: 308 snapshots at 100 outlets and 608 at 200,
so `8 + 6 x O`. At 670 outlets that is 4,028, and with 1,366 matrix names the
snapshots copy 5,502,248 inherited properties.

```text
/aux;a;b;c;...;zm(a:/()b:/()c:/()...)      670 outlets x 1,366 matrix names
```

```bash
./scripts/validate.sh aux
```

256 MiB, one request, three fresh workers per arm. Every arm in the first three
rows is the same 8,021 bytes and builds the same 4,028 snapshots. Only the number
of distinct names changes:

| arm | outlets | matrix names | bytes | outcome | median peak |
| --- | ------: | -----------: | ----: | ------- | ----------: |
| candidate, 1,366 distinct | 670 | 1,366 | 8,021 | **3/3 fatal** | 299 MiB |
| cliff control, 1,365 distinct | 670 | 1,366 | 8,021 | 0/3 fatal | 206 MiB |
| equal bytes, 2 distinct | 670 | 1,366 | 8,021 | 0/3 fatal | 57 MiB |
| matrix width only | 0 | 1,366 | 4,050 | 0/3 fatal | 53 MiB |
| outlet fan-out only | 670 | 0 | 3,975 | 0/3 fatal | 55 MiB |

The cliff control repeats the last name, so the request keeps every byte and every
parsed entry while the map ends up one own property short. That isolates the V8
dictionary capacity step from the byte count: 1,365 names sit at capacity 2,048
and 1,366 at 4,096. All four survivors return the same 870-byte body, SHA-256
`fc0cb53d...`.

Largest heap one request kills:

| heap | candidate |
| ---: | --------- |
| 128 MiB | **3/3 fatal** |
| 256 MiB | **3/3 fatal** |
| 512 MiB | 0/3 fatal, 356 MiB peak |

This shape is stronger than the query one for the same budget. 8,021 bytes kills
256 MiB where the 7,873-byte query payload kills 128, because six snapshots per
outlet instead of four, and because matrix names spend no `?` and the outlets
carry no separator.

The fix closes it. At 1,024 MiB nothing dies on either build, so the peak is a
peak and not a floor:

| heap | stock | patched |
| ---: | ----- | ------- |
| 256 MiB | **3/3 fatal**, 1,747 ms | **0/3 fatal**, 247 ms |
| 1,024 MiB | 343 MiB peak, 1,550 ms | **72 MiB peak**, 225 ms |

An earlier revision of this file reported the opposite. `validate.sh` rebuilds the
images at the top of the script, so pre-building with `ROUTER_PATCH` and then
calling it rebuilt stock over the patched image, and three different builds
produced numbers within 1.3% of each other. `start_fresh_worker` now greps the
running worker's own bundle for a marker only the requested patch can have put
there, and a mismatch fails the trial as `wrong-build`.

## Isolating it

Proof-only edits to `@angular/router`, applied at image build time. The default is
`none`, which is stock, and that is what every number above uses.

```bash
ROUTER_PATCH=count       docker compose up -d --build --wait app
ROUTER_PATCH=share-query docker compose up -d --build --wait app
```

`count` reports what recognition built, one line per burst, reset after each line
so the line belongs to the request that produced it:

```json
{"snapshots":1926,"queryKeysCopied":2652102}
```

`share-query` creates and freezes the query map once per recognition attempt and
shares it. It is the causal ablation, not a proposed fix:

```diff
- Object.freeze({...this.urlTree.queryParams}),
+ (this.__shared ??= Object.freeze({...this.urlTree.queryParams})),
```

| 128 MiB, candidate | Outcome | Median time | Median peak |
| --- | --- | ----------: | ----------: |
| Stock | 5/5 fatal | 1,050 ms | 213 MiB (floor) |
| Query-sharing | **0/5 fatal** | 212 ms | 76 MiB |

Same bytes, same outlets, same names, same `a362f24f…` body.

## The fix

`app/router-fix.mjs` is the candidate fix, as twelve edits to the compiled bundle.
It runs standalone against any application's copy:

```bash
node app/router-fix.mjs node_modules/@angular/router/fesm2022/_router-chunk.mjs
```

Or at image build time:

```bash
ROUTER_PATCH=fix       docker compose up -d --build --wait app
ROUTER_PATCH=fix-count docker compose up -d --build --wait app
```

Every edit must match exactly once or nothing is written, so a bundle of another
shape fails the build instead of getting half-patched. All twelve match once
against 22.2.0 as published on npm.

Three changes. The first one alone stops the OOM:

1. The Recognizer owns one frozen query map per recognition attempt and hands the
   same reference to every snapshot, memoised on `urlTree.queryParams` identity so
   a redirect that replaces the `UrlTree` gets a new one.
2. The pre-match snapshot becomes a thunk that `runCanMatchGuards()` and
   `getRedirectResult()` call only when they have a guard or a `RedirectFunction`.
3. `getInherited()` returns the parent's already-frozen objects when the child
   contributes nothing, and builds `resolve` behind a getter that
   `createSnapshot()` never reads.

```bash
./scripts/validate.sh fixcheck
```

| arm | stock | patched |
| --- | ----- | ------- |
| 8 KiB candidate, 128 MiB | 5/5 fatal, 1,050 ms | **0/5 fatal**, 178 ms, 76 MiB |
| 16 KiB optimised, 512 MiB | 5/5 fatal, 4,743 ms | **0/5 fatal**, 241 ms, 106 MiB |
| guard at 4 concurrent, 128 MiB | fatal | **0/5 fatal**, 415 ms, 100 MiB |

All three answer the same 328-byte body and SHA-256 that stock answers. On the
patched build one request builds 963 snapshots instead of 1,926, and copies the map
once: 1,377 properties instead of 2,652,102.

The guard row needs a word. A guarded route still builds its pre-match snapshot,
because it has a guard to hand it to. What changed is that the snapshot shares one
frozen map instead of copying it, so there is nothing left to retain across the
await.

`fixcheck` does not exercise `paramsInheritanceStrategy: 'always'`, static route
titles or resolvers, which is what change 3 touches.

## Manual test

The candidate intentionally crashes the SSR worker. Use only this disposable local
stack.

```bash
HEAP_MB=128 docker compose up -d --wait app
HEAP_MB=128 docker compose --profile test run --rm candidate
docker compose logs app | grep -E 'Reached heap limit|JavaScript heap out of memory'
docker inspect "$(docker compose ps -a -q app)" --format '{{.State.OOMKilled}}'
```

Expected: a V8 heap error and `false`. Swap `candidate` for `control` to send the
byte-identical harmless request. `SHAPE` picks the route shape: `shop`, `shop1` for
one empty-path level, `shop3` and `shop4` for three and four, `layout` for a
component on the level, `guard`, `guard3` and `guard4` for the async `canMatch`.
`OUTLETS` and `QUERY_NAMES` size the URL, `CONCURRENCY` sends more than one,
`NO_SEP=1` drops the separator and `FOLLOW=1` follows the redirect.

The app is on `127.0.0.1:4000` and Nginx on `127.0.0.1:8080`.

## Where this stops

It needs SSR, a route reachable through empty-path levels, and a catch-all so the
request survives the `@angular/ssr` route tree, which splits the path on `/` and
would otherwise answer 404 without reaching recognition.

Depth is the application's choice, not the attacker's, and it is the strongest
multiplier: one level reaches 256 MiB at 16 KiB, four reaches 1,024 MiB. At 8 KiB
the arm is capped at capacity 4,096 and cannot reach 512 MiB at any depth or split
that fits the budget.

It is not a permanent event-loop spin. Recognition finishes. The demonstrated
boundary is heap exhaustion and process termination.

## Clean up

```bash
docker compose down -v --remove-orphans
```

## Environment

```text
Node.js:     24.16.0 in the image
Angular:     22.2.0 production AOT (@angular/router and @angular/ssr 22.2.0)
SSR engine:  AngularNodeAppEngine + Express 5.1.0
Nginx:       1.31.5, defaults except the 16k request line and the response buffer
Docker:      29.7.2, Compose v5.5.0
```
