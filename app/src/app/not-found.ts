import { Component } from "@angular/core";

// An ordinary 404 page. Its only role here is that a catch-all route exists,
// which is what puts a "**" entry in the SSR manifest and lets any URL reach
// Router recognition. See README, "The SSR route-tree gate".
@Component({
  selector: "app-not-found",
  template: '<main id="not-found">Not found</main>',
})
export class NotFound {}
