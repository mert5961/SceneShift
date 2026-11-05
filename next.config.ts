import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static: depth runs in the browser, so the site can live on GitHub Pages.
  output: "export",
  basePath: process.env.BASE_PATH || "",
  env: { NEXT_PUBLIC_BASE_PATH: process.env.BASE_PATH || "" },
  images: { unoptimized: true },
};

export default nextConfig;
