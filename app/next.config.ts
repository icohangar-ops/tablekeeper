import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // db/schema.sql is read at runtime by the migrator (e.g. on first boot in a
  // fresh environment). Trace it into serverless output so it is always there.
  outputFileTracingIncludes: {
    "/**": ["./db/schema.sql"],
  },
  // PGlite resolves its WASM + contrib extension bundles (btree_gist) via
  // import.meta.url against real files on disk. Bundling them breaks the
  // paths ("Extension bundle not found" / URL-vs-path TypeErrors), so keep
  // the package external in server bundles.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
