import { Component } from "@angular/core";

// The second configured outlet. Its only role is that the inner level has two
// empty-path children instead of one, which is what makes recognition build six
// snapshots per URL outlet rather than four.
@Component({
  selector: "app-modal-page",
  template: '<aside id="modal-page">Modal</aside>',
})
export class ModalPage {}
