import { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { routes } from "./app.routes";

// Nothing opted into. No withRouterConfig, no queryParamsHandling, no custom
// UrlSerializer, no redirects, no custom matchers. The Router is wired the way
// the CLI wires it. The canMatch and the resolve in app.routes.ts belong to the
// two amplifier arms; the /shop shape that carries the headline result reaches
// neither of them.
export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
