FROM node:22-alpine@sha256:b64da1de5a51067ab8e75f0bc8dbd0905d8894baa22261f439a4572f41291e50 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
# Both tsconfigs: `build` compiles with tsconfig.build.json, which extends
# tsconfig.json. Copying only the latter fails the build with TS5083.
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine@sha256:b64da1de5a51067ab8e75f0bc8dbd0905d8894baa22261f439a4572f41291e50
WORKDIR /app
RUN apk add --no-cache tini
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ dist/
COPY drizzle/ drizzle/
COPY scripts/ scripts/
# scripts/apply-rls.ts and scripts/rotate-key.ts import ../src/*.js and run under
# tsx, so `npm run db:bootstrap` (render.yaml preDeployCommand) and
# `npm run db:rotate-key` need the sources present. Without this the first
# Render deploy fails at ERR_MODULE_NOT_FOUND even though the build is green.
# Copied from the build stage so it is byte-identical to what was compiled.
COPY --from=build /app/src/ src/
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# Reads PORT rather than assuming 3000, so the same image works behind any port
# mapping (docker-compose, Render, or a local override).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]
