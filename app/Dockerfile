FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# none (default) builds stock @angular/router. See README, "Isolating it".
ARG ROUTER_PATCH=none
RUN node patch-router.mjs "$ROUTER_PATCH"
RUN npm run build

FROM node:24.16.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 4000
CMD ["node", "dist/router-oom-e2e/server/server.mjs"]
