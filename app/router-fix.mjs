// The candidate fix for the auxiliary-outlet recognition blow-up, as edits to
// @angular/router's compiled FESM bundle.
//
//   node router-fix.mjs node_modules/@angular/router/fesm2022/_router-chunk.mjs
//
// Every edit must match exactly once or the script exits non-zero without
// writing, so a bundle of a different shape fails loudly instead of silently
// half-patching. Verified against @angular/router 22.2.0 as published on npm:
// all 12 sites match once.
//
// Three things are going on, and only the first is needed to stop the OOM:
//
//   Shared frozen query map  (edits 7, 8, 9, 11a)
//     createSnapshot() froze a fresh copy of the whole URL-global query map into
//     every snapshot. The Recognizer now owns one frozen object per recognition
//     attempt and hands the same reference to every snapshot. The memo is keyed
//     on urlTree.queryParams identity, so a redirect that replaces the UrlTree
//     gets a new object rather than a stale one.
//
//   No pre-match snapshot without a canMatch  (edits 3, 4, 5, 6, 10)
//     matchWithChecks() built a pre-match snapshot per route attempt before it
//     knew whether the route had any guard to hand it to. The snapshot becomes a
//     thunk that runCanMatchGuards() and getRedirectResult() call only when they
//     actually have a guard or a RedirectFunction. This halves the snapshot count
//     and, for routes that DO have an async canMatch, removes the retention that
//     makes concurrency a lever.
//
//   Inherited params and data shared, resolve made lazy  (edits 1, 2, 11b)
//     getInherited() built three spread objects per snapshot. It now returns the
//     parent's already-frozen object when the child contributes nothing, and
//     builds `resolve` behind a getter, which createSnapshot() never reads. This
//     closes the same shape driven by a segment's matrix parameters rather than
//     the query string.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

export const FIX_EDITS = [
  // 1. Add the isEmptyObject helper next to getDataKeys.
  [
    `function getDataKeys(obj) {
  return [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)];
}`,
    `function getDataKeys(obj) {
  return [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)];
}
function isEmptyObject(obj) {
  if (obj === null || obj === undefined) {
    return true;
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return Object.getOwnPropertySymbols(obj).length === 0;
}`,
  ],

  // 2. getInherited: share the parent's frozen objects; build `resolve` lazily.
  [
    `  let inherited;
  const {
    routeConfig
  } = route;
  if (parent !== null && (paramsInheritanceStrategy === 'always' || routeConfig?.path === '' || !parent.component && !parent.routeConfig?.loadComponent)) {
    inherited = {
      params: {
        ...parent.params,
        ...route.params
      },
      data: {
        ...parent.data,
        ...route.data
      },
      resolve: {
        ...route.data,
        ...parent.data,
        ...routeConfig?.data,
        ...route._resolvedData
      }
    };
  } else {
    inherited = {
      params: {
        ...route.params
      },
      data: {
        ...route.data
      },
      resolve: {
        ...route.data,
        ...(route._resolvedData ?? {})
      }
    };
  }
  if (routeConfig && hasStaticTitle(routeConfig)) {
    inherited.resolve[RouteTitleKey] = routeConfig.title;
  }
  return inherited;`,
    `  const {
    routeConfig
  } = route;
  const inheritedParent = parent !== null && (paramsInheritanceStrategy === 'always' || routeConfig?.path === '' || !parent.component && !parent.routeConfig?.loadComponent) ? parent : null;
  let resolve;
  const computeResolve = () => {
    const result = inheritedParent ? {
      ...route.data,
      ...inheritedParent.data,
      ...routeConfig?.data,
      ...route._resolvedData
    } : {
      ...route.data,
      ...(route._resolvedData ?? {})
    };
    if (routeConfig && hasStaticTitle(routeConfig)) {
      result[RouteTitleKey] = routeConfig.title;
    }
    return result;
  };
  if (inheritedParent) {
    return {
      params: isEmptyObject(route.params) ? inheritedParent.params : Object.freeze({
        ...inheritedParent.params,
        ...route.params
      }),
      data: isEmptyObject(route.data) ? inheritedParent.data : Object.freeze({
        ...inheritedParent.data,
        ...route.data
      }),
      get resolve() {
        return resolve ??= computeResolve();
      }
    };
  }
  return {
    params: Object.freeze({
      ...route.params
    }),
    data: Object.freeze({
      ...route.data
    }),
    get resolve() {
      return resolve ??= computeResolve();
    }
  };`,
  ],

  // 3. runCanMatchGuards: take a thunk, call it only when the route has a canMatch guard.
  [
    `function runCanMatchGuards(injector, route, segments, urlSerializer, currentSnapshot, abortSignal) {
  const canMatch = route.canMatch;
  if (!canMatch || canMatch.length === 0) return of(true);
  const canMatchObservables`,
    `function runCanMatchGuards(injector, route, segments, urlSerializer, getCurrentSnapshot, abortSignal) {
  const canMatch = route.canMatch;
  if (!canMatch || canMatch.length === 0) return of(true);
  const currentSnapshot = getCurrentSnapshot();
  const canMatchObservables`,
  ],

  // 4. applyRedirectCommands: forward the thunk.
  [
    `  async applyRedirectCommands(segments, redirectTo, posParams, currentSnapshot, injector) {
    const redirect = await getRedirectResult(redirectTo, currentSnapshot, injector);`,
    `  async applyRedirectCommands(segments, redirectTo, posParams, getCurrentSnapshot, injector) {
    const redirect = await getRedirectResult(redirectTo, getCurrentSnapshot, injector);`,
  ],

  // 5. getRedirectResult: build the snapshot only for a RedirectFunction.
  [
    `function getRedirectResult(redirectTo, currentSnapshot, injector) {
  if (typeof redirectTo === 'string') {
    return Promise.resolve(redirectTo);
  }
  const redirectToFn = redirectTo;
  return firstValueFrom(`,
    `function getRedirectResult(redirectTo, getCurrentSnapshot, injector) {
  if (typeof redirectTo === 'string') {
    return Promise.resolve(redirectTo);
  }
  const redirectToFn = redirectTo;
  const currentSnapshot = getCurrentSnapshot();
  return firstValueFrom(`,
  ],

  // 6. matchWithChecks: pass a thunk instead of a built snapshot.
  [
    `  const currentSnapshot = createPreMatchRouteSnapshot(createSnapshot(result));
  injector = getOrCreateRouteInjectorIfNeeded(route, injector);
  return runCanMatchGuards(injector, route, segments, urlSerializer, currentSnapshot, abortSignal)`,
    `  injector = getOrCreateRouteInjectorIfNeeded(route, injector);
  return runCanMatchGuards(injector, route, segments, urlSerializer, () => createPreMatchRouteSnapshot(createSnapshot(result)), abortSignal)`,
  ],

  // 7. Recognizer: memo fields.
  [
    `  absoluteRedirectCount = 0;
  allowRedirects = true;
  constructor(injector, configLoader,`,
    `  absoluteRedirectCount = 0;
  allowRedirects = true;
  frozenQueryParamsSource;
  frozenQueryParams;
  constructor(injector, configLoader,`,
  ],

  // 8. Recognizer: the shared frozen queryParams getter.
  [
    `    this.applyRedirects = new ApplyRedirects(this.urlSerializer, this.urlTree);
  }
  noMatchError(e) {`,
    `    this.applyRedirects = new ApplyRedirects(this.urlSerializer, this.urlTree);
  }
  get queryParams() {
    if (this.frozenQueryParamsSource !== this.urlTree.queryParams) {
      this.frozenQueryParamsSource = this.urlTree.queryParams;
      this.frozenQueryParams = Object.freeze({
        ...this.urlTree.queryParams
      });
    }
    return this.frozenQueryParams;
  }
  noMatchError(e) {`,
  ],

  // 9. Root snapshot uses the shared object.
  [
    `    const rootSnapshot = new ActivatedRouteSnapshot([], Object.freeze({}), Object.freeze({
      ...this.urlTree.queryParams
    }), this.urlTree.fragment,`,
    `    const rootSnapshot = new ActivatedRouteSnapshot([], Object.freeze({}), this.queryParams, this.urlTree.fragment,`,
  ],

  // 10. Redirect pre-match snapshot becomes a thunk.
  [
    `    const currentSnapshot = this.createSnapshot(injector, route, segments, parameters, parentRoute);
    if (this.abortSignal.aborted) {
      throw new Error(this.abortSignal.reason);
    }
    const newTree = await this.applyRedirects.applyRedirectCommands(consumedSegments, route.redirectTo, positionalParamSegments, createPreMatchRouteSnapshot(currentSnapshot), injector);`,
    `    if (this.abortSignal.aborted) {
      throw new Error(this.abortSignal.reason);
    }
    const newTree = await this.applyRedirects.applyRedirectCommands(consumedSegments, route.redirectTo, positionalParamSegments, () => createPreMatchRouteSnapshot(this.createSnapshot(injector, route, segments, parameters, parentRoute)), injector);`,
  ],

  // 11. createSnapshot: shared queryParams, and stop re-freezing what getInherited already froze.
  [
    `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, Object.freeze({
      ...this.urlTree.queryParams
    }), this.urlTree.fragment, getData(route),`,
    `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, this.queryParams, this.urlTree.fragment, getData(route),`,
  ],
  [
    `    snapshot.params = Object.freeze(inherited.params);
    snapshot.data = Object.freeze(inherited.data);`,
    `    snapshot.params = inherited.params;
    snapshot.data = inherited.data;`,
  ],
];

// The createSnapshot line after the fix, so the counting instrumentation has
// something to anchor on when both are applied.
export const FIXED_SNAPSHOT_ANCHOR =
  `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, this.queryParams, this.urlTree.fragment, getData(route),`;

export function applyFix(source) {
  let out = source;
  FIX_EDITS.forEach(([find, replace], i) => {
    const n = out.split(find).length - 1;
    if (n !== 1) {
      throw new Error(
        `EDIT ${i + 1}: expected exactly 1 match, found ${n}. The bundle does not have the shape this fix expects. First 200 chars sought:\n${find.slice(0, 200)}`,
      );
    }
    out = out.replace(find, replace);
  });
  return out;
}

// CLI: patch a bundle in place, with a .orig backup.
if (process.argv[1] && process.argv[1].endsWith("router-fix.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node router-fix.mjs <_router-chunk.mjs>");
    process.exit(1);
  }
  let patched;
  try {
    patched = applyFix(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  if (!existsSync(file + ".orig")) copyFileSync(file, file + ".orig");
  writeFileSync(file, patched);
  console.log(`patched ${FIX_EDITS.length} sites in ${file} (backup at ${file}.orig)`);
}
