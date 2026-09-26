FROM node:22-alpine@sha256:b64da1de5a51067ab8e75f0bc8dbd0905d8894baa22261f439a4572f41291e50 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
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
