import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack scoped to this repository. Without an explicit root it
  // detects a parent package-lock.json and emits a workspace-root warning.
  turbopack: {
    root: __dirname,
  },
  // Surprise me (/treasure) was retired in Oct 2026; old links land on the
  // landing page, whose "Barista's choice" plays the same role.
  async redirects() {
    return [{ source: "/treasure", destination: "/", permanent: true }];
  },
};

export default nextConfig;
