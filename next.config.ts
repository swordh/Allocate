import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Firebase Auth email links require the path /__/auth/action.
      // We rewrite internally to our custom handler at /auth/action.
      {
        source: '/__/auth/action',
        destination: '/auth/action',
      },
    ]
  },
};

export default nextConfig;
