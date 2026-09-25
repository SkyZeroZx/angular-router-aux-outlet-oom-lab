import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

// A layout shell on an empty-path level, which is the most common real shape of
// one: a componentless level groups providers or guards, a component-bearing one
// holds chrome. Whether the level carries a component decides nothing about
// whether it fans out, which is what the /layout shape measures.
@Component({
  selector: "app-layout",
  imports: [RouterOutlet],
  template: "<router-outlet />",
})
export class Layout {}
