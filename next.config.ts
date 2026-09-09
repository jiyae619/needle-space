import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack scoped to this repository. Without an explicit root it
  // detects a parent package-lock.json and emits a workspace-root warning.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
