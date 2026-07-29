import type { NextConfig } from "next";

const pagesBasePath = (process.env.GITHUB_PAGES_BASE_PATH ?? "").replace(
  /\/+$/,
  "",
);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SITE_BASE_PATH: pagesBasePath,
  },
};

export default nextConfig;
