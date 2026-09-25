import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

// One ordinary primary outlet. The application declares no named outlets and
// renders no RouterLinks; every outlet the Router recognises comes from the URL.
@Component({
  selector: "app-root",
  imports: [RouterOutlet],
  template: "<router-outlet />",
})
export class App {}
