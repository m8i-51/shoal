import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin stays false so the API server sees the dev server's Host
      // header; its host/origin guard (server/auth.ts) checks both.
      "/api": { target: "http://localhost:4000", changeOrigin: false },
      "/sessions": { target: "http://localhost:4000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
  },
});
