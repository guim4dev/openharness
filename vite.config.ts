import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend build for @openharness/desktop. The UI sources live in
// apps/desktop/ui; the production bundle Tauri loads is emitted to
// apps/desktop/dist-ui. Vitest uses vitest.config.ts, not this file.
export default defineConfig({
  root: "apps/desktop/ui",
  plugins: [react()],
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
  },
});
