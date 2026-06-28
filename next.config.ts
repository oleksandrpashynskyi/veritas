import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @react-pdf/renderer ships Node-native deps (yoga-layout, fontkit). Keep it external so the bundler
  // uses native require inside the Node route handlers instead of trying to bundle them — the documented
  // fix for App-Router server-side PDF rendering. Its ONLY consumers are the export route handlers
  // (src/app/jobs/[id]/export/**/route.ts), which render server-side with runtime = "nodejs".
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
