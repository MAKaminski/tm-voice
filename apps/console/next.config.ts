import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const nextConfig: NextConfig = { output: "standalone", reactStrictMode: true, outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../..") };
export default nextConfig;
