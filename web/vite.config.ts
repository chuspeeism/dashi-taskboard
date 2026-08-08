import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    // Keep several worktrees running side by side: override both ports per instance,
    // e.g. TASKBOARD_WEB_PORT=5174 CODEX_TASKBOARD_PORT=47901 npm run dev
    port: Number(process.env.TASKBOARD_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${Number(process.env.CODEX_TASKBOARD_PORT ?? 47823)}`,
    },
  },
});
