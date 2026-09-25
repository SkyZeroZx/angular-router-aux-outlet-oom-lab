import { Routes } from "@angular/router";
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

  // An ordinary 404 page. Without a catch-all the SSR route tree answers 404
  // for anything but "/shop" and "/guard", and the URL never reaches Router
  // recognition.
  { path: "**", component: NotFound },
];
