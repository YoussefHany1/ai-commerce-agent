# Next.js standalone build for the merchant dashboard.
# Build:  docker build -f web/Dockerfile -t ai-commerce-agent-web .  (context: repo root)
# Compose builds it via the `web` service.
#
# Node 22 matches the API image and CI.
#
# Build-time vs runtime: NEXT_PUBLIC_API_URL is the only variable needed at build
# time. It is inlined into the client bundle as the public API origin used for the
# OAuth link and the webhook display. Every privileged variable — API_URL,
# ADMIN_API_KEY, SESSION_SECRET, REDIS_URL — is read at runtime by the server
# bundle, with no build arg, so there is no second copy of a secret that could drift
# from the one the service actually runs with.
#
# The standalone layout below assumes .next/standalone/server.js. next.config.mjs pins
# outputFileTracingRoot to the web directory so Next cannot infer the repo root (it
# has a lockfile too) and nest the bundle at .next/standalone/web/server.js, which
# would leave CMD pointing at a file that does not exist.

FROM node:22-alpine AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app/web
COPY --from=deps /app/web/node_modules ./node_modules
COPY web/ .
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Render and other PaaS providers inject PORT; the server binds whatever it is given.
ENV PORT=3001
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./.next/static
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;fetch('http://127.0.0.1:'+p+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# The Next standalone server binds `process.env.HOSTNAME || '0.0.0.0'`, and Docker
# populates HOSTNAME with the container's own hostname at container start — which
# overrides any image-level ENV. That makes an `ENV HOSTNAME=0.0.0.0` here
# unreliable: the server binds loopback only and the container is unreachable from
# the network even though the image is built correctly. Setting it via `env` in the
# command gives the node process the right value regardless of what the platform
# injected, and `exec` keeps node as PID 1 so it still receives SIGTERM directly.
CMD ["sh", "-c", "exec env HOSTNAME=0.0.0.0 node server.js"]
