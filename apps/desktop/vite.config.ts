import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend build for @openharness/desktop. UI sources live in ./ui; the
// production bundle Tauri loads (tauri.conf.json build.frontendDist) is emitted
// to ./dist-ui. Co-located so `vite` / `vite build` work from this package dir,
// which is where `tauri dev` / `tauri build` invoke the before* commands.
// Vitest uses the repo-root vitest.config.ts, not this file.
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
  },
});
