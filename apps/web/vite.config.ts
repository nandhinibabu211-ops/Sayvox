import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        signin: resolve(import.meta.dirname, "signin.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        install: resolve(import.meta.dirname, "install.html"),
      },
    },
  },
});
