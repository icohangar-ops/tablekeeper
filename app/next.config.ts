import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // db/schema.sql is read at runtime by the migrator (e.g. on first boot in a
  // fresh environment). Trace it into serverless output so it is always there.
  outputFileTracingIncludes: {
    "/**": ["./db/schema.sql"],
  },
};

export default nextConfig;
