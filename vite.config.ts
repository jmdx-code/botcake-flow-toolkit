import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Inject loaders dynamically import these entry modules. Keeping entry
        // names stable prevents an in-place dist rebuild from deleting the
        // exact hashed file an already loaded unpacked extension still uses.
        entryFileNames: "assets/[name].js",
        chunkFileNames: (chunk) => {
          if (chunk.name === "index.tsx") return "assets/content-entry.js";
          if (chunk.name === "botcake-main.entry.ts") return "assets/botcake-main-entry.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
