import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/wasm database drivers run as plain Node modules rather than being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
