import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must see Rust errors in the terminal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: process.env["TAURI_ENV_DEBUG"] ? false : "esbuild",
    sourcemap: Boolean(process.env["TAURI_ENV_DEBUG"]),
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        overlay: resolve(import.meta.dirname, "overlay.html"),
      },
    },
  },
});
