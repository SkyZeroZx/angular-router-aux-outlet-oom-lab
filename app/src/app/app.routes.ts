import { Routes } from "@angular/router";
import { Layout } from "./layout";
import { NotFound } from "./not-found";
import { ShopPage } from "./shop-page";

// How long the async canMatch guard on /guard waits, per invocation. The guard
// is evaluated once per URL outlet per empty-path level, so this is a per-check
// delay, not a per-request one. See README, "What the guard costs".
const CANMATCH_MS =
  Number(
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.["CANMATCH_MS"] ?? "",
  ) || 0;

// Yields the event loop from inside recognition, while the pre-match snapshot
// and every parent frame are still live.
const slowMatch = () =>
  new Promise<boolean>((resolve) => setTimeout(() => resolve(true), CANMATCH_MS));

export const routes: Routes = [
  // The basic shape: two consecutive empty-path levels under one normal path.
  // Componentless empty routes are the documented way to group providers,
  // guards, lazy boundaries or layout without adding another URL segment. One
  // request is enough against this one.
  {
    path: "shop",
    children: [
      {
        path: "",
        children: [{ path: "", component: ShopPage }],
      },
    ],
  },

  // One empty-path level instead of two, so the depth term in the snapshot
  // count is measured against the same request rather than asserted.
  {
    path: "shop1",
    children: [{ path: "", component: ShopPage }],
  },

  // Three and four consecutive empty-path levels. Depth is the application's
  // choice, not the attacker's, and recognition pays for it linearly, so these
  // are here to measure the multiplier rather than to argue it. Written out
  // literally, like every other shape in this file.
  {
    path: "shop3",
    children: [
      {
        path: "",
        children: [
          {
            path: "",
            children: [{ path: "", component: ShopPage }],
          },
        ],
      },
    ],
  },

  {
    path: "shop4",
    children: [
      {
        path: "",
        children: [
          {
            path: "",
            children: [
              {
                path: "",
                children: [{ path: "", component: ShopPage }],
              },
            ],
          },
        ],
      },
    ],
  },

  // Two empty-path levels again, but the outer one carries a layout component
  // instead of being componentless. This is the shape most applications actually
  // have, so it decides whether the precondition is "componentless grouping" or
  // just "an empty-path level".
  {
    path: "layout",
    children: [
      {
        path: "",
        component: Layout,
        children: [{ path: "", component: ShopPage }],
      },
    ],
  },

  // The same shape with an async canMatch guard on the outer empty-path level.
  // Concurrent requests overlap here, so their peaks add up.
  {
    path: "guard",
    children: [
      {
        path: "",
        canMatch: [slowMatch],
        children: [{ path: "", component: ShopPage }],
      },
    ],
  },

  // The guarded shape at three and four empty-path levels. The guard stays on the
  // OUTER level in every one of them, so the only thing that changes between
  // /guard, /guard3 and /guard4 is how many levels the fan-out runs through.
  // Without these the depth question can only be answered for the no-guard
  // column, which is half the table.
  {
    path: "guard3",
    children: [
      {
        path: "",
        canMatch: [slowMatch],
        children: [
          {
            path: "",
            children: [{ path: "", component: ShopPage }],
          },
        ],
      },
    ],
  },

  {
    path: "guard4",
    children: [
      {
        path: "",
        canMatch: [slowMatch],
        children: [
          {
            path: "",
            children: [
              {
                path: "",
                children: [{ path: "", component: ShopPage }],
              },
            ],
          },
        ],
      },
    ],
  },

  // An ordinary 404 page. Without a catch-all the SSR route tree answers 404
  // for anything but the paths above, and the URL never reaches Router
  // recognition. See README, "It needs a catch-all route".
  { path: "**", component: NotFound },
];
