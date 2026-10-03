import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const appRoot = path.resolve(process.argv[2] ?? 'hunt-app');
const mode = process.argv[3] ?? 'static';
const angularVersion = process.argv[4] ?? process.env.ANGULAR_VERSION ?? '22.2.1';
if (!['static', 'fresh'].includes(mode)) {
  throw new Error(`Unknown mode: ${mode}`);
}

async function put(relativePath, content) {
  const file = path.join(appRoot, relativePath);
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, content.trimStart(), 'utf8');
}

const packageJsonPath = path.join(appRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
for (const name of [
  '@angular/common',
  '@angular/compiler',
  '@angular/core',
  '@angular/platform-browser',
  '@angular/platform-server',
  '@angular/router',
  '@angular/ssr',
]) {
  packageJson.dependencies[name] = angularVersion;
}
for (const name of ['@angular/build', '@angular/cli', '@angular/compiler-cli']) {
  packageJson.devDependencies[name] = angularVersion;
}
packageJson.scripts = {...packageJson.scripts, build: 'ng build'};
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

await put('src/app/app.ts', String.raw`
import {ChangeDetectionStrategy, Component} from '@angular/core';
import {RouterOutlet} from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<router-outlet />',
})
export class App {}
`);

await put('src/app/home.ts', String.raw`
import {ChangeDetectionStrategy, Component, REQUEST, inject} from '@angular/core';

@Component({
  standalone: true,
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: 'CONTROL|url={{url}}|marker={{marker}}',
})
export class Home {
  private readonly request = inject(REQUEST);
  readonly url = this.request?.url ?? 'null';
  readonly marker = this.request?.headers.get('x-probe-marker') ?? 'null';
}
`);

await put('src/app/app.routes.ts', String.raw`
import {Routes} from '@angular/router';
import {Home} from './home';

export function createRoutes(): Routes {
  return [
    {path: '', pathMatch: 'full', component: Home},
    {
      path: 'lazy',
      loadChildren: () => import('./lazy/lazy.module').then((m) => m.LazyModule),
    },
    {path: 'control', component: Home},
    {path: '**', component: Home},
  ];
}

export const routes: Routes = createRoutes();
`);

await put('src/app/app.config.ts', String.raw`
import {ApplicationConfig} from '@angular/core';
import {provideRouter} from '@angular/router';
import {routes} from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
`);

await put('src/app/app.routes.server.ts', String.raw`
import {RenderMode, ServerRoute} from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {path: '**', renderMode: RenderMode.Server},
];
`);

await put('src/app/app.config.server.ts', String.raw`
import {ApplicationConfig, mergeApplicationConfig} from '@angular/core';
import {provideServerRendering, withRoutes} from '@angular/ssr';
import {appConfig} from './app.config';
import {serverRoutes} from './app.routes.server';

const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(withRoutes(serverRoutes))],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
`);

await put('src/app/lazy/lazy-state.service.ts', String.raw`
import {DestroyRef, Injectable, REQUEST, inject} from '@angular/core';

type ProbeMetrics = {
  constructed: number;
  destroyed: number;
  touches: number;
  instances: Array<{
    id: number;
    capturedUrl: string;
    capturedMarker: string;
    capturedCookie: string;
  }>;
};

declare global {
  // eslint-disable-next-line no-var
  var __ANGULAR_LAZY_CROSS_REQUEST_PROBE__: ProbeMetrics | undefined;
}

function metrics(): ProbeMetrics {
  return (globalThis.__ANGULAR_LAZY_CROSS_REQUEST_PROBE__ ??= {
    constructed: 0,
    destroyed: 0,
    touches: 0,
    instances: [],
  });
}

@Injectable()
export class LazyStateService {
  private readonly request = inject(REQUEST);
  private readonly destroyRef = inject(DestroyRef);
  readonly id: number;
  readonly capturedUrl = this.request?.url ?? 'null';
  readonly capturedMarker = this.request?.headers.get('x-probe-marker') ?? 'null';
  readonly capturedCookie = this.request?.headers.get('cookie') ?? 'null';
  private hits = 0;

  constructor() {
    const state = metrics();
    this.id = ++state.constructed;
    state.instances.push({
      id: this.id,
      capturedUrl: this.capturedUrl,
      capturedMarker: this.capturedMarker,
      capturedCookie: this.capturedCookie,
    });
    console.log(
      'PROBE_SERVICE_CONSTRUCT id=' + this.id + ' marker=' + this.capturedMarker + ' url=' + this.capturedUrl,
    );
    this.destroyRef.onDestroy(() => {
      state.destroyed++;
      console.log('PROBE_SERVICE_DESTROY id=' + this.id);
    });
  }

  touch(): number {
    metrics().touches++;
    return ++this.hits;
  }
}
`);

await put('src/app/lazy/lazy.component.ts', String.raw`
import {ChangeDetectionStrategy, Component, REQUEST, inject} from '@angular/core';
import {LazyStateService} from './lazy-state.service';

@Component({
  standalone: true,
  selector: 'app-lazy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: 'PROBE|service={{serviceId}}|hit={{hit}}|capturedUrl={{capturedUrl}}|capturedMarker={{capturedMarker}}|capturedCookie={{capturedCookie}}|directUrl={{directUrl}}|directMarker={{directMarker}}|directCookie={{directCookie}}',
})
export class LazyComponent {
  private readonly state = inject(LazyStateService);
  private readonly request = inject(REQUEST);
  readonly serviceId = this.state.id;
  readonly hit = this.state.touch();
  readonly capturedUrl = this.state.capturedUrl;
  readonly capturedMarker = this.state.capturedMarker;
  readonly capturedCookie = this.state.capturedCookie;
  readonly directUrl = this.request?.url ?? 'null';
  readonly directMarker = this.request?.headers.get('x-probe-marker') ?? 'null';
  readonly directCookie = this.request?.headers.get('cookie') ?? 'null';
}
`);

await put('src/app/lazy/lazy.module.ts', String.raw`
import {NgModule} from '@angular/core';
import {RouterModule} from '@angular/router';
import {LazyComponent} from './lazy.component';
import {LazyStateService} from './lazy-state.service';

@NgModule({
  imports: [
    LazyComponent,
    RouterModule.forChild([{path: '', component: LazyComponent}]),
  ],
  providers: [LazyStateService],
})
export class LazyModule {}
`);

await put('src/main.ts', String.raw`
import {bootstrapApplication} from '@angular/platform-browser';
import {App} from './app/app';
import {appConfig} from './app/app.config';

bootstrapApplication(App, appConfig).catch(console.error);
`);

if (mode === 'static') {
  await put('src/main.server.ts', String.raw`
import {BootstrapContext, bootstrapApplication} from '@angular/platform-browser';
import {App} from './app/app';
import {config} from './app/app.config.server';

const bootstrap = (context: BootstrapContext) => bootstrapApplication(App, config, context);
export default bootstrap;
`);
} else {
  await put('src/main.server.ts', String.raw`
import {ApplicationConfig} from '@angular/core';
import {BootstrapContext, bootstrapApplication} from '@angular/platform-browser';
import {provideRouter} from '@angular/router';
import {provideServerRendering, withRoutes} from '@angular/ssr';
import {App} from './app/app';
import {createRoutes} from './app/app.routes';
import {serverRoutes} from './app/app.routes.server';

const bootstrap = (context: BootstrapContext) => {
  const freshConfig: ApplicationConfig = {
    providers: [
      provideRouter(createRoutes()),
      provideServerRendering(withRoutes(serverRoutes)),
    ],
  };
  return bootstrapApplication(App, freshConfig, context);
};

export default bootstrap;
`);
}

await put('src/server.ts', String.raw`
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';

const app = express();
const angularApp = new AngularNodeAppEngine({
  allowedHosts: ['localhost', '127.0.0.1'],
});

app.get('/__health', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.get('/__metrics', (_req, res) => {
  res.status(200).json(
    globalThis.__ANGULAR_LAZY_CROSS_REQUEST_PROBE__ ?? {
      constructed: 0,
      destroyed: 0,
      touches: 0,
      instances: [],
    },
  );
});

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, '127.0.0.1', (error) => {
    if (error) throw error;
    console.log('PROBE_SERVER_READY port=' + port);
  });
}

export const reqHandler = createNodeRequestHandler(app);
`);

console.log(JSON.stringify({appRoot, mode, angularVersion}));
