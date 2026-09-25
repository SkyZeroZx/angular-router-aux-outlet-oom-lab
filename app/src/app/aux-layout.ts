import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

// Holds both configured outlets for the /aux shape. The primary outlet lives in
// the root component, so the named one has to live somewhere that only /aux
// reaches: putting it in the root template would change every other arm's
// rendered bytes, and those bytes are an invariant the other arms assert on.
@Component({
  selector: "app-aux-layout",
  imports: [RouterOutlet],
  template: '<router-outlet /><router-outlet name="modal" />',
})
export class AuxLayout {}
