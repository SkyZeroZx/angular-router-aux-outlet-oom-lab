# Angular Router auxiliary-outlet SSR OOM

Minimal reproduction of an Angular Router out-of-memory failure during
server-side rendering (SSR).

```text
Candidate: /shop/(a:/()//b:/()//...)?a&b&c&d&...   480 outlets, 1,377 names
Control:   /shop/(a:/()//b:/()//...)?a&a&a&a&...   480 outlets,     2 names
```

Both URLs are the same 7,873 bytes, declare the same outlets and carry the same
query pairs. They differ only in how many *distinct* names the query map ends up
with. One candidate request exhausts a 128 MiB SSR worker; the control answers
and the worker stays up.

Recognition walks every auxiliary outlet the URL declares, an empty-path route
matches each one without consuming a segment, and every snapshot built along the
way copies the whole URL-global query map. The URL pays for the outlets and the
names once each; the Router pays for their product — **1,926 snapshots and
2,652,102 query-property copies**, before anything is merged or rendered.

Nothing here is numeric, so this is not the matrix-parameter family
[#70716](https://github.com/angular/angular/issues/70716) /
[#70717](https://github.com/angular/angular/pull/70717) fixed. It reproduces on
22.2.0, the release that carries that fix.

## What the application has to look like

```ts
export const routes: Routes = [
  {
    path: "shop",
    children: [{ path: "", children: [{ path: "", component: ShopPage }] }],
  },
  { path: "**", component: NotFound },
];
```

`provideRouter(routes)` and one `<router-outlet />`. No RouterLinks, no
`queryParamsHandling`, no guards, resolvers, redirects, custom matchers or
serializers. That is what separates this from the earlier query-parameter
report, where the cost was substantially application-driven.

The catch-all is a real precondition rather than decoration. `@angular/ssr`
matches its own compile-time `RouteTree` before the Router runs, and splits the
path on `/`, so `/shop/(a:/())` arrives as `['shop', '(a:', '())']` and misses.
With only the `shop` route the payload gets a 404 without ever reaching
recognition. A `**` route puts `/**` in the manifest and every URL reaches the
Router, which is what almost every application has, because almost every
application has a 404 page.

## Where it comes from

`@angular/router` 22.2.0, `fesm2022/_router-chunk.mjs`:

- `processChildren()` recognises every child outlet, then calls
  `mergeEmptyPathMatches(children)` *after* the loop. The merge keeps the final
  route state small, but it cannot give back what building the duplicates cost.
- `match()`, line 2905, lets an empty-path route match while consuming nothing,
  including for outlets it was not configured for. One `{ path: "" }` matches
  all 480.
- `createSnapshot()`, line 3160, does `Object.freeze({ ...this.urlTree.queryParams })`
  per snapshot. Query parameters are global to the URL, not specific to the
  branch being built.
- `matchWithChecks()`, line 2898, builds a second, pre-match snapshot per route
  attempt — unconditionally, before it knows whether the route has any
  `canMatch` guards.

Two empty-path levels, a pre-match and a final snapshot at each, is four
snapshots per outlet: `2(D + 1) + 2 x D x O` for `D` levels and `O` outlets.

`name:/()` is the compact spelling of a named outlet holding an empty child
group. The terser `name:` does not work: the parser folds the outlets into one
group and the fan-out disappears.

## Automated test

Starts fresh containers, runs the control, triggers the candidate, and confirms
Docker did not kill the container. Evidence lands in `evidence/`.

```bash
./scripts/validate.sh shop
```

```text
== shop | heap 128 MiB | 480 outlets | 1 request ==
[PASS] control: worker survived.
[PASS] candidate: V8 heap limit reached, worker gone, OOMKilled=false.
```

`OOMKilled=false` is what separates V8 reaching `--max-old-space-size` from the
kernel reaping the container. `mem_limit` is set well above the V8 limit so the
two cannot be confused.

Each trial also checks the worker's own command line before measuring anything.
A container reused at the wrong heap looks exactly like a result, which is how
measurements go quietly wrong.

## The async canMatch guard

`/guard` is the same route shape with an async `canMatch` on the outer
empty-path level. `matchWithChecks()` builds its pre-match snapshot and then
awaits the guards with that snapshot, and every parent recognition frame, still
live. That is the one hook that yields the event loop from *inside* recognition,
so concurrent requests overlap their speculative trees and the peaks add up.

```bash
./scripts/validate.sh guard
```

120 outlets at 128 MiB, so that one request is not already fatal and concurrency
is the variable:

```text
canMatch   requests to OOM    control at that count
0 ms       4                  4/4 survived
100 ms     4                  4/4 survived
250 ms     4                  4/4 survived
500 ms     4                  4/4 survived
```

The delay does not move the count. What matters is that the guard is async at
all; how long it waits only changes how long the window stays open. The
byte-identical control survives at the same concurrency in every row.

`canMatch` is ordinary — feature flags, entitlement checks and A/B routing all
use it, and an async one is the normal case.

### What the guard costs

The guard is evaluated once per URL outlet, not once per request, so its
per-check delay multiplies by the outlet count. 500 ms against the canonical 480
outlets is four minutes of wall clock for a single request, which is why this arm
uses 120.

## Through Nginx

Both request-line sizes, four heaps, with and without the guard, behind Nginx
with `large_client_header_buffers 4 16k` — the AWS Elastic Load Balancer request
line, and its only setting that is not an Nginx default.

```bash
./scripts/validate.sh matrix
```

| Request line | Heap | No guard | Async canMatch |
| -----------: | ---: | -------: | -------------: |
| 7,888 B | 128 MiB | **1** | **1** |
| | 256 MiB | none up to 6 | **3** |
| | 512 MiB | none up to 6 | **5** |
| | 1,024 MiB | none up to 6 | none up to 6 |
| 16,255 B | 128 MiB | **1** | **1** |
| | 256 MiB | **1** | **1** |
| | 512 MiB | none up to 6 | **2** |
| | 1,024 MiB | none up to 6 | **4** |

Two things fall out of it.

Without the guard, concurrency buys nothing: either one request already exceeds
the heap or six do not. Recognition saturates the thread, requests serialize, and
each snapshot tree is collectable before the next one peaks. The lever is request
size, not request rate.

With the guard, concurrency compounds and the two levers multiply: four 16 KiB
requests take down a 1 GiB worker.

Neither size needs anything tuned to be accepted. 7,888 bytes of request line
fits Node's default 16 KiB header budget on its own, and 16,255 still fits it
once Nginx has added `Host` and the `X-Forwarded-*` headers on top. Past that
Node answers 431 and the request never reaches the Router.

## Manual test

The candidate intentionally crashes the SSR worker. Use only this disposable
local stack.

```bash
HEAP_MB=128 docker compose up -d --wait app
HEAP_MB=128 docker compose --profile test run --rm candidate
```

Confirm the V8 failure:

```bash
docker compose logs app | grep -E 'Reached heap limit|JavaScript heap out of memory'
docker inspect "$(docker compose ps -a -q app)" --format '{{.State.OOMKilled}}'
```

Expected: a V8 heap error and `false`. Swap `candidate` for `control` to send the
byte-identical harmless request. `SHAPE=guard` targets the guarded route,
`OUTLETS` and `QUERY_NAMES` size the URL, and `CONCURRENCY` sends more than one.

The app is on `127.0.0.1:4000` and Nginx on `127.0.0.1:8080`.

## Isolating it

Two proof-only edits to `@angular/router`, applied at image build time. The
default is `none`, which is stock and is what every number above uses.

```bash
ROUTER_PATCH=count docker compose up -d --build --wait app
```

Reports what recognition actually built, one line per request in the app log:

```json
{"snapshots":1926,"queryKeysCopied":2652102}
```

```bash
ROUTER_PATCH=share-query docker compose up -d --build --wait app
```

Creates and freezes the query map once per recognition attempt and shares it,
instead of copying it into every snapshot:

```diff
- Object.freeze({...this.urlTree.queryParams}),
+ (this.__shared ??= Object.freeze({...this.urlTree.queryParams})),
```

Same bytes, same outlets, same names, same rendered output, and at 128 MiB the
candidate that is fatal on stock answers 302 in 184 ms with the worker healthy.
That is the causal ablation, not a proposed fix: a real change has to own the
frozen map deliberately and hold immutability, redirects, inheritance and public
snapshot semantics.

## Where this stops

It needs SSR, a route reachable through empty-path levels, and a catch-all so
the request survives the `@angular/ssr` route tree. Depth is the application's
choice, not the attacker's: one empty-path level instead of two halves the work.

It is not a permanent event-loop spin either. Recognition finishes; the
demonstrated boundary is heap exhaustion and process termination.

## Clean up

```bash
docker compose down -v --remove-orphans
```

## Environment

```text
Node.js:     24.16.0 in the image
Angular:     22.2.0 production AOT (@angular/router and @angular/ssr 22.2.0)
SSR engine:  AngularNodeAppEngine + Express 5.1.0
Nginx:       1.31.5, default configuration except the 16k request line
Docker:      29.7.2, Compose v5.5.0
```
