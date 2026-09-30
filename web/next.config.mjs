import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').AppConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Pinned to the app directory. Without this, Next infers the workspace root from
  // the nearest lockfile — which is the repo root, since it has one too — and emits
  // the standalone bundle as .next/standalone/web/server.js instead of
  // .next/standalone/server.js. web/Dockerfile copies the flat layout, so the
  // inference silently breaks the image.
  outputFileTracingRoot: webDir,
  // Same reason: silences the "inferred your workspace root" warning and keeps
  // Turbopack from walking the API's tree.
  turbopack: { root: webDir },
  // No `/api/:path*` rewrite here on purpose, and this still holds with a shared
  // tunnel. A rewrite would forward the browser's request straight to the API,
  // bypassing the route handlers under app/api/ that hold the session and attach the
  // credential server-side — every dashboard call would arrive unauthenticated. Those
  // handlers are the only thing serving /api/*, and a top-level `rewrites()` is
  // `afterFiles`, so it would not even fire for those paths.
  //
  // The tunnel also fronts this app, so Shopify's webhook and OAuth-callback traffic
  // lands here too. Both are relayed by explicit route handlers rather than rewrites:
  //   app/webhooks/[platform]/route.ts          raw-body relay; re-serialising the JSON
  //                                             would invalidate Shopify's HMAC
  //   app/api/oauth/[platform]/callback/route.ts shop is not redirected through the
  //                                             session-authenticated allowlist
  // Both are deliberately absent from that allowlist, which is why they cannot reuse it.
};

export default nextConfig;
