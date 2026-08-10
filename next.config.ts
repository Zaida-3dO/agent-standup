import type { NextConfig } from "next";

const config: NextConfig = {
  // The Dockerfile copies .next/standalone; keeps the runtime image small.
  output: "standalone",
  // Pin the file-tracing root to this project. Without it, Next.js guesses
  // based on the nearest lockfile above this directory, which is a
  // dev-machine detail, not something a Docker build or CI runner should
  // depend on.
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
