# Angular Router auxiliary-outlet SSR OOM

Minimal reproduction of an Angular Router out-of-memory failure during
server-side rendering (SSR).

```text
Candidate: /shop/(a:/()//b:/()//...)?a&b&c&d&...   480 outlets, 1,377 names
Control:   /shop/(a:/()//b:/()//...)?a&a&a&a&...   480 outlets,     2 names
```

Both URLs are the same 7,873 bytes, declare the same outlets and carry the same
query pairs. They differ only in how many _distinct_ names the query map ends up
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

### It needs a catch-all route

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
  `mergeEmptyPathMatches(children)` _after_ the loop. The merge keeps the final
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

Every table in this file is one arm of the same script, and every arm writes its
own logs into `evidence/`. `TRIALS` sets how many fresh workers each repeated
arm uses, and defaults to five.

```bash
./scripts/validate.sh arms      # both dimensions, then each alone, 128 MiB
./scripts/validate.sh diff      # the same four arms where none of them die
./scripts/validate.sh counts    # snapshots and query copies, per depth
./scripts/validate.sh ablation  # stock against the shared-query-map edit
./scripts/validate.sh guard     # the async canMatch sweep
./scripts/validate.sh matrix    # four heaps and both sizes, through Nginx
```

Peak memory is the container's own monotonic cgroup counter polled at 20 Hz, so
on an arm that dies it is a floor rather than the peak: the container takes the
counter with it.

Recognition ends on a redirect to the merged URL, so the rendered page is one
hop past the measured request. `FOLLOW=1` takes that hop and hashes what comes
back, which is how the arms are compared on their output. It is off by default,
because a second request per arm would change what the concurrency arms measure.

## The async canMatch guard

`/guard` is the same route shape with an async `canMatch` on the outer
empty-path level. `matchWithChecks()` builds its pre-match snapshot and then
awaits the guards with that snapshot, and every parent recognition frame, still
live. That is the one hook that yields the event loop from _inside_ recognition,
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

Both request-line sizes, four heaps, with and without the guard, behind Nginx.
Two settings there are not Nginx defaults. `large_client_header_buffers 4 16k`
is the AWS Elastic Load Balancer request line, on the request path. The other is
`proxy_buffer_size`: recognition ends on a redirect to the merged URL, so the
response carries a `Location` as long as the request line, and at Nginx's
one-page default every proxied response comes back 502 with "upstream sent too
big header" instead of the app's own status. That is on the response path — it
changes what the client is shown, never what the server accepts.

```bash
./scripts/validate.sh matrix
```

| Request line |      Heap |    No guard |   Async canMatch |
| -----------: | --------: | ----------: | ---------------: |
|      7,888 B |   128 MiB |       **1** |            **1** |
|              |   256 MiB | survives 16 |            **2** |
|              |   512 MiB | survives 16 |            **5** |
|              | 1,024 MiB | survives 16 | between 6 and 16 |
|     16,255 B |   128 MiB |       **1** |            **1** |
|              |   256 MiB |       **1** |            **1** |
|              |   512 MiB | survives 16 |            **2** |
|              | 1,024 MiB | survives 16 |            **4** |

A bare number is the lowest concurrency that lost the worker. `survives 16` means
sixteen concurrent requests left it healthy — the ramp probes its ceiling first,
so a cell that survives the ceiling is one measurement rather than a wasted
climb, and the number it reports is the evidence rather than the ramp's own
limit.

Two things fall out of it.

Without the guard, concurrency buys nothing: either one request already exceeds
the heap or sixteen do not. Recognition saturates the thread, requests serialize,
and each snapshot tree is collectable before the next one peaks. The lever is
request size, not request rate.

With the guard, concurrency compounds and the two levers multiply: four 16 KiB
requests take down a 1 GiB worker.

The exact count at a boundary moves by one between runs — the 8 KiB, 256 MiB,
guarded cell has measured both 2 and 3. Treat these as the boundary to within a
request, not as constants.

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
byte-identical harmless request. `SHAPE` picks the route shape — `shop`, `shop1`
for one empty-path level instead of two, and `guard` for the async
`canMatch` — `OUTLETS` and `QUERY_NAMES`
size the URL, `CONCURRENCY` sends more than one, and `FOLLOW=1` follows the
redirect to the rendered page.

The app is on `127.0.0.1:4000` and Nginx on `127.0.0.1:8080`.

## Isolating it

Two proof-only edits to `@angular/router`, applied at image build time. The
default is `none`, which is stock and is what every number above uses.

```bash
ROUTER_PATCH=count docker compose up -d --build --wait app
```

Reports what recognition actually built, one line per burst in the app log,
reset after each line so it is the request that produced it rather than every
request since the worker booted:

```json
{ "snapshots": 1926, "queryKeysCopied": 2652102 }
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
