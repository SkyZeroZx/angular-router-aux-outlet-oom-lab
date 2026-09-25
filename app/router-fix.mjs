// The candidate fix from the validation task, Appendix A:
// `fix(router): do not copy URL-sized objects into every route snapshot`, as edits to
// @angular/router's compiled FESM bundle.
//
//   node router-fix.mjs node_modules/@angular/router/fesm2022/_router-chunk.mjs
//
// Every edit must match exactly once or the script exits non-zero without writing,
// so a bundle of a different shape fails loudly instead of silently half-patching.
// Not taken from the GitHub PR page: if the two ever diverge this file follows the
// Appendix. Verified against @angular/router 22.2.0 as published on npm: all seven sites
// match once.
//
// The Appendix makes three changes. This file is those three and nothing else, because
// an earlier version of it also deferred the pre-match snapshot behind a thunk,
// which halves the snapshot count and is NOT part of the PR. Measuring a superset
// and reporting it as the PR is how a wrong conclusion gets published.
//
//   Shared frozen query map
//     createSnapshot() froze a fresh copy of the whole URL-global query map into
//     every snapshot. The Recognizer now owns one frozen object per recognition
//     attempt and hands the same reference to every snapshot. The memo is keyed on
//     urlTree.queryParams identity, so a redirect that replaces the UrlTree gets a
//     new object rather than a stale one.
//
//   Shared inherited params and data
//     getInherited() copied {...parent.params, ...route.params} per snapshot, so
//     matrix parameters on a consumed segment cost the product of their width and
//     the number of routes matched. It now returns the parent's already-frozen
//     object when the child contributes nothing of its own.
//
//   Lazy resolve
//     getInherited() also built a four-way spread for `resolve` that
//     createSnapshot() never reads. It is now a getter, built on first read.
//
// One knowing difference from the Appendix: it declares its helper inside getInherited so
// the router bundle's symbol golden stays untouched. That golden does not exist for
// a FESM patch, so the helper sits at module scope here as isEmptyObject. Same
// behaviour; it would fail the Appendix's own gate D and nothing else.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

export const FIX_EDITS = [
  // 1. The helper, which the PR declares inside getInherited.
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

  // 3. Recognizer: the memo fields behind the shared query map.
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

  // 4. Recognizer: the getter itself.
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

  // 5. The root snapshot uses the shared object.
  [
    `    const rootSnapshot = new ActivatedRouteSnapshot([], Object.freeze({}), Object.freeze({
      ...this.urlTree.queryParams
    }), this.urlTree.fragment,`,
    `    const rootSnapshot = new ActivatedRouteSnapshot([], Object.freeze({}), this.queryParams, this.urlTree.fragment,`,
  ],

  // 6. And so does every other snapshot.
  [
    `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, Object.freeze({
      ...this.urlTree.queryParams
    }), this.urlTree.fragment, getData(route),`,
    `    const snapshot = new ActivatedRouteSnapshot(segments, parameters, this.queryParams, this.urlTree.fragment, getData(route),`,
  ],

  // 7. getInherited already froze these, so stop re-freezing them.
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
