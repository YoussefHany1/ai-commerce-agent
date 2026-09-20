/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    const api = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
    if (!api) return [];
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
    ];
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;