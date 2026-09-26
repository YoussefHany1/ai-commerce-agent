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
  // No `/api/:path*` rewrite here on purpose. A rewrite would forward the browser's
  // request straight to the API, bypassing the route handlers under app/api/ that
  // hold the operator session and attach the credential server-side. Those handlers
  // are the only thing serving /api/*.
};

export default nextConfig;
