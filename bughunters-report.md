# Angular Router: SSR heap exhaustion through auxiliary-outlet fan-out over a wide query map

**Product:** Angular — `@angular/router` (Google OSS VRP, OT0)
**Affected component:** `Recognizer.createSnapshot()`, `Recognizer.processChildren()`, `matchWithChecks()`
**Affected versions:** `@angular/router` 22.2.0; the logic is unchanged from earlier branches
**Tested on:** 22.2.0 with `@angular/ssr` 22.2.0, Node 24.16.0, V8 13.6.233.17-node.49, production AOT SSR
**Proposed severity:** High — CVSS 4.0 8.2, `AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N`
**Reproduction:** attached `angular-router-aux-outlet-oom-lab.zip`, a Docker Compose stack driven by one script

Context on who is reporting: I reported issue #70716 and authored PR #70717, the
matrix-parameter fix that landed in 22.2.0, and I have a separate report open on
`parseQueryParam()`. This is a third, different root. There is no numeric name
anywhere in this payload, and #70717's hardening is present and working in the
build I tested.

I'm proposing the same severity vector as CVE-2026-54268
(`GHSA-48r7-hpm6-gfxm`, the `formatDate` SSR OOM), since the reachability and
impact are the same shape: unauthenticated, remote, no user interaction,
availability only, with a precondition on how the application is routed.

Why this one differs from my query-parameter report: that one needed the
application to opt into `queryParamsHandling: "merge"` and render a hundred
RouterLinks, and the response that it is substantially application-driven was
fair. This needs neither. The application is `provideRouter(routes)` with an
ordinary route group and a 404 page, it renders no links, and the Router builds
the whole multiplier itself while recognising one incoming URL.

---

**Vulnerability Description**

Recognition turns two attacker-controlled dimensions of one URL into a
multiplicative allocation, against a route depth the application already has:

```text
auxiliary outlets in the URL  x  distinct query names  x  empty-path route depth
```

Three behaviours combine, each reasonable on its own. In `@angular/router`
22.2.0, `fesm2022/_router-chunk.mjs`:

1. `processChildren()` recognises every child outlet the URL declares, then calls
   `mergeEmptyPathMatches(children)` *after* the loop. The merge does its job —
   the final route state is small — but it cannot give back the memory spent
   building the branches it discards.
2. `match()`, line 2905, lets an empty-path route match while consuming nothing,
   including for outlets it was not configured for. That is deliberate and
   supports primary empty routes holding named-outlet children. It also means one
   configured `{ path: '' }` matches every outlet the URL invents.
3. `createSnapshot()`, line 3160, copies the entire query map into every
   snapshot. Query parameters are global to the URL, not specific to the branch
   being built:

```js
const snapshot = new ActivatedRouteSnapshot(segments, parameters, Object.freeze({
  ...this.urlTree.queryParams
}), this.urlTree.fragment, ...);
```

`matchWithChecks()`, line 2898, builds a second, pre-match snapshot per route
attempt — unconditionally, before it knows whether the route has any `canMatch`
guards to run. Two empty-path levels, a pre-match and a final snapshot at each,
is four snapshots per attacker-declared outlet. Measured, recognition builds
`2(D + 1) + 2 x D x O` snapshots for `D` empty-path levels and `O` outlets.

One unauthenticated GET of **7,873 bytes** therefore makes the Router build
**1,926 speculative snapshots** and copy **2,652,102 query properties** before
anything is merged or rendered. The request line is 7,888 bytes, inside Node's
own default 16 KiB header budget, so nothing upstream or in the runtime has to be
relaxed to accept it.

The application never reads these parameters or declares these outlets. Both come
entirely from the URL, so there is no point in application code where they could
have been validated or rejected.

---

**Attack Preconditions**

1. The application is server-side rendered (`@angular/ssr`). This is a
   server-side memory exhaustion; a browser-only app is not affected the same way.
2. A route reachable through at least one empty-path level. Componentless empty
   routes are the documented way to group providers, guards, lazy boundaries or
   layout without adding a URL segment. The reproduction uses two, which is an
   ordinary feature shape; one level halves the work and needs a larger request
   for the same boundary.
3. A catch-all `**` route. This one is not obvious and I flag it in Scope below
   rather than let triage find it.
4. Network reachability to the SSR endpoint. No account, no privileges, no user
   interaction, and no concurrency.

No precondition requires the application to use auxiliary outlets, to read query
parameters, to render links, or to opt into any Router configuration. It needs no
guards, resolvers, redirects, custom matchers or custom URL serializers. The
fixture is `provideRouter(routes)`, a single `<router-outlet />`, and:

```ts
export const routes: Routes = [
  {
    path: "shop",
    children: [{ path: "", children: [{ path: "", component: ShopPage }] }],
  },
  { path: "**", component: NotFound },
];
```

---

**Reproduction Steps / POC**

Target: Angular 22.2.0 (`@angular/router` and `@angular/ssr` both 22.2.0),
production AOT SSR build on Node 24.16.0 in the image, Docker 29.7.2 with
Compose v5.5.0. The stack in the attached archive exposes only
`127.0.0.1:4000`, contacts no Google or third-party service, and needs no
reverse proxy: the request fits Node's own default header budget.

```bash
unzip angular-router-aux-outlet-oom-lab.zip -d angular-router-aux-outlet-oom-lab
cd angular-router-aux-outlet-oom-lab
./scripts/validate.sh shop
```

The script starts fresh containers, runs the control, triggers the candidate,
and asserts that Docker did not kill the container:

```text
== shop | heap 128 MiB | 1 request ==
[PASS] control: worker survived.
[PASS] candidate: V8 heap limit reached, worker gone, OOMKilled=false.
```

Equivalent manual run:

```bash
HEAP_MB=128 docker compose up -d --wait app
HEAP_MB=128 docker compose --profile test run --rm candidate
docker compose logs app | grep -E 'Reached heap limit|JavaScript heap out of memory'
docker inspect "$(docker compose ps -a -q app)" --format '{{.State.OOMKilled}}'
```

The request under test:

```text
/shop/(a:/()//b:/()//c:/()//...)?a&b&c&d&e&...
```

480 named auxiliary outlets, each holding an empty primary child group, then
1,377 distinct query names. Every name is one or two ASCII letters: nothing
numeric, nothing percent-encoded, no matrix parameters and no fragment.
`name:/()` is the compact spelling of a named outlet with an empty child group —
the terser `name:` folds the outlets into one group and produces no fan-out.

The control is byte-for-byte identical, with the same 480 outlets and the same
1,377 query pairs, and collapses only the *distinct* name count: each one-letter
name becomes `a`, each two-letter name becomes `aa`. The Router parses the same
pairs and retains the same values; each snapshot's map owns two names instead of
1,377. That isolates query-map width from the pair count and from the request
size, both of which cost something regardless.

*Reproduction output*

```text
{"arm":"candidate","outlets":480,"queryNames":1377,"pathBytes":7873,
 "requestLineBytes":7888,"destination":"http://127.0.0.1:4000"}
{"arm":"candidate","result":{"error":"ECONNRESET","ms":767},"followed":null}

FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The worker exits and the health check that follows is refused. Container state
reads `"OOMKilled":false`, which is what distinguishes V8 reaching
`--max-old-space-size` from the kernel reaping the container; `mem_limit` is set
well above the V8 limit so the two cannot be confused.

128 MiB old space, one request per trial, five fresh workers per arm. The last
two columns come from a build instrumented only at `createSnapshot()`:

| Arm | Outlets | Distinct names | Bytes | Outcome | Median peak RSS | Snapshots | Keys copied |
| --- | ------: | -------------: | ----: | ------- | --------------: | --------: | ----------: |
| Candidate | 480 | 1,377 | 7,873 | **5/5 fatal OOM** | 300.03 MiB | 1,926 | **2,652,102** |
| Control, equal bytes | 480 | 2 | 7,873 | 5/5 healthy | 88.32 MiB | 1,926 | 3,852 |
| Query width only | 0 | 1,377 | 4,084 | 5/5 healthy | 87.47 MiB | 6 | 8,262 |
| Outlet fan-out only | 480 | 0 | 3,794 | 5/5 healthy | 88.31 MiB | 1,926 | 0 |

*Isolating the cause.* Neither dimension is sufficient alone: both
single-dimension arms carry the full count of their own dimension and sit at the
control's RSS. Three of the four arms build the same 1,926 snapshots — what
differs is the width of the object copied into each one.

At a roomy 256 MiB every arm survives, which makes the differential readable:
the candidate takes 725 ms and 323.75 MiB against the control's 142 ms and
102.08 MiB. All four arms return the same 328-byte body, SHA-256
`a362f24fdef25afbf75b8ade21ee30bec38783d2ed646a501f6b970aca6b5d34`, so the
effect is not response size or different application output.

*Causal ablation.* Creating and freezing the query map once per recognition
attempt and sharing it across the snapshots:

```diff
- Object.freeze({...this.urlTree.queryParams}),
+ (this.__shared ??= Object.freeze({...this.urlTree.queryParams})),
```

| 128 MiB, candidate | Outcome | Median time | Median peak RSS |
| --- | --- | ----------: | --------------: |
| Stock `@angular/router` | 5/5 fatal | 833 ms | 300.03 MiB |
| Query-sharing ablation | **5/5 healthy** | 157 ms | 89.23 MiB |

Same bytes, same outlets, same names, same rendered output. I am offering this as
proof of the invariant, not as the patch.

*Scaling with the request line.* Work is about `depth x outlets x names` and the
request is about `outlets + names`, so the strongest request for a byte budget
splits it evenly between the two dimensions:

| Request line | Outlets x names | Snapshots | Largest heap one request kills |
| -----------: | --------------: | --------: | ------------------------------ |
| 7,888 B | 480 x 1,377 | 1,926 | 128 MiB |
| 16,255 B | 1,020 x 2,726 | 4,086 | **256 MiB** |

16 KiB is the request line the AWS Elastic Load Balancer forwards and the size my
earlier reports used, so they line up directly. Both sizes are chosen to pass
untuned: 7,888 bytes fits Node's default 16 KiB header budget on its own, and
16,255 still fits it once Nginx has added `Host` and the `X-Forwarded-*` headers
on top. Past that Node answers 431 and the request never reaches the Router.

Both the snapshot counts and the ablation above are reproducible from the same
archive, through one build argument that applies a one-line edit to
`@angular/router` — `count` reports the two totals once per request in the app
log, `share-query` is the ablation. The default is `none`, which is stock and is
what every other number here uses:

```bash
ROUTER_PATCH=count       docker compose up -d --build --wait app
ROUTER_PATCH=share-query docker compose up -d --build --wait app
```

---

**Attack Scenario and Security Impact**

Any unauthenticated remote party who can reach the SSR endpoint can exploit this.
No account, no privileges, no victim interaction, and no prior knowledge of the
application beyond one path that routes through an empty-path group — which is
discoverable by loading the site.

The attacker sends one well-formed GET of under 8 KiB, within the limits every
proxy and runtime ships with. The worker terminates with `JavaScript heap out of
memory`. Every in-flight request on that worker is lost and the process must
restart; under a supervisor or orchestrator it restarts and the next request can
kill it again, so roughly one request per restart cycle from a single machine
keeps the rendering tier down.

Impact is availability of the rendering tier. There is no confidentiality or
integrity impact — nothing is disclosed and no data is altered — which is why I
scored `VC:N/VI:N/VA:H`. The cost asymmetry is what makes it practical: about
7.9 KB of attacker traffic per worker killed, with no botnet, no sustained flood
and no concurrency.

*One amplifier worth weighing separately.* On the fixture as described,
concurrency does not compound: recognition saturates the thread, requests
serialize, and each snapshot tree is collectable before the next one peaks, so 32
concurrent 8 KiB requests leave a 256 MiB worker healthy. Adding a 500 ms route
resolver — the shape my earlier report relied on — does not change that either,
because `mergeEmptyPathMatches()` has already dropped the duplicate branches by
the time a resolver runs.

An async `canMatch` guard does change it. `matchWithChecks()` awaits the guards
with the pre-match snapshot and every parent recognition frame still live, which
is the one hook that yields the event loop from inside recognition, so several
requests' speculative trees coexist.

The full grid, behind Nginx, ramping concurrency to six per cell:

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

Without the guard, either one request already exceeds the heap or six do not.
With it the two levers multiply, and four 16 KiB requests take down a 1 GiB
worker. `canMatch` is ordinary; feature flags, entitlement checks and A/B
routing all use it, and an async one is the normal case.

How long the guard waits does not matter — only that it is async. Swept at 0,
100, 250 and 500 ms per check against 120 outlets at 128 MiB, the count is four
in every row, and the byte-identical control survives four in every row.

---

**Scope and Limitations**

Four things narrow this, and I would rather state them than have triage find
them.

*It needs a catch-all route, and I did not expect that.* `@angular/ssr` matches
the request against its own compile-time `RouteTree` before Angular's Router
runs, and `getPathSegments()` splits the path on `/`. So `/shop/(a:/())` arrives
as `['shop', '(a:', '())']`, walks off the end of a tree holding only `/shop`,
and `AngularServerApp.handle()` returns `null`. Measured on the fixture without a
`**` route: HTTP 404 in 63 ms, worker untouched, recognition never reached. A
`**` route puts `/**` in the manifest and every URL reaches the Router. Almost
every real application has one, because almost every application has a 404 page —
but the payload is inert without it.

*Through a standard proxy the practical reach is workers up to about 256 MiB.*
One request kills 128 MiB at 7.9 KiB and 256 MiB at the 16 KiB an ALB forwards.
Going further needs a request line past 16 KiB, which most deployments will not
forward, and — absent an async `canMatch` — concurrency will not substitute for
size. So this is strongest against memory-constrained containerised SSR, which is
common, rather than universal against any Angular SSR deployment.

*The depth is the application's, not the attacker's.* Measured on the same
request, one empty-path level is 964 snapshots and 1,327,428 copies against
1,926 and 2,652,102 for two. Applications with no empty-path grouping under the
targeted path are not affected by this shape.

*It is not a permanent event-loop spin.* Recognition yields between route checks
and finishes. The demonstrated boundary is heap exhaustion and process
termination, and I am not claiming more than that.

I have verified the four code sites above against `@angular/router` 22.2.0 as
published on npm. I have not re-run the matrix against a fresh build of `main`,
so I am not asserting current-`main` status beyond that the same functions are
present in the released source I tested.

---

**Suggested Fix**

In the order I would investigate them:

1. **Create and freeze the query parameter map once per recognition attempt and
   share it across every snapshot that attempt builds.** This is the one I
   measured: it converts the candidate from 5/5 fatal to 5/5 healthy at 128 MiB
   with identical output. My ablation is a one-line experiment and is not a
   production patch — a real change has to own the frozen map deliberately and
   preserve `ActivatedRouteSnapshot.queryParams` immutability, query-param arrays
   and enumeration, redirects that replace the current `UrlTree`,
   `paramsInheritanceStrategy`, custom serializers, and public snapshot access
   semantics.
2. **Do not build the pre-match snapshot when the route has no `canMatch`
   guards.** On its own this only lowers the constant, but it also removes the
   retention that makes concurrency a lever for routes that *do* have one, so it
   is worth more than the snapshot count suggests.
3. **Deduplicate equivalent empty-path branches before materialising full
   snapshots,** rather than merging them afterwards.
4. Defence in depth: budgets for parsed outlet count and query width in SSR
   request routing.
5. A regression benchmark asserting work proportional to the serialized URL
   rather than to the outlet/query cross-product. The control workload in the
   archive doubles as one: same bytes, same pair count, same rendered output, and
   the differential collapses when the invariant holds.

I am happy to prepare and test the follow-up patch against `main` if that is
useful, as I did for #70717.

---

**Archive Contents**

`angular-router-aux-outlet-oom-lab.zip`, sources and evidence only — no
`node_modules`, no build output. `app/package-lock.json` is included so the
dependency tree resolves to exactly what I tested.

```text
├── docker-compose.yml        app plus the candidate and control clients
├── README.md                 methodology and measurements
├── angular-issue.md          condensed write-up
├── app/                      Angular 22.2.0 SSR fixture
│   ├── src/app/app.routes.ts the two route shapes and the 404 route
│   └── patch-router.mjs      the two proof-only edits, off by default
├── client/                   workload builder and request sender
├── scripts/validate.sh       both arms, one command each
└── evidence/                 client output, app logs and container state
                              for every run quoted above
```

`app/patch-router.mjs` runs at image build time and only when `ROUTER_PATCH` asks
for it; the default leaves `@angular/router` stock. It anchors on the exact text
of `createSnapshot()` and fails the build if a future version changes it.

**References**

- Issue #70716 and PR #70717 — the matrix-parameter fix, which I authored. Its
  hardening is present in the build tested here and does not affect this result;
  no name in this payload is numeric.
- CVE-2026-54268 / `GHSA-48r7-hpm6-gfxm` — prior Angular SSR OOM DoS, rated High
  at CVSS 8.2, used here as the severity reference.
