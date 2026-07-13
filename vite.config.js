import { defineConfig } from "vite";

// Local dev serves everything from public/ (all scenes).
// Hosted build (VITE_HOSTED=1) uses public-hosted/ which contains only the
// small kiruya assets, so GitHub Pages stays under its size limits.
export default defineConfig({
  publicDir: process.env.VITE_HOSTED ? "public-hosted" : "public",
});
