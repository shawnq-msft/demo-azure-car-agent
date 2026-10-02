FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build --workspace @car/api
# Prune only after esbuild has run; retain workspace links and runtime dependencies.
RUN npm prune --omit=dev && mkdir -p apps/api/node_modules

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
# Retain the workspace target for npm links; the build alias bundles raw TS
# contracts instead of depending on Node's version-specific TS loader.
COPY --from=build --chown=node:node /app/packages ./packages
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
