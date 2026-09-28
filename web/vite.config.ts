import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiTarget = environment.VITE_TASKBOARD_API_TARGET ?? "http://127.0.0.1:47823";

  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    base: "./",
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": apiTarget,
      },
    },
  };
});
