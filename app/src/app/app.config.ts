import { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { routes } from "./app.routes";

// Nothing opted into. No withRouterConfig, no queryParamsHandling, no custom
// UrlSerializer, no guards, no resolvers, no redirects, no custom matchers.
// The Router is wired the way the CLI wires it.
export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
