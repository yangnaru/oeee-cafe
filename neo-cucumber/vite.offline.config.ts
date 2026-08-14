import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { lingui } from "@lingui/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  // Library mode does not replace CommonJS environment guards automatically.
  // The offline bundle runs directly in browsers, where `process` does not
  // exist, so select production React/Lingui branches at build time.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    // Exact patterns, not prefixes: a bare string alias for "neo-cucumber"
    // also rewrites "neo-cucumber/style.css" into a path that does not exist.
    alias: [
      {
        find: /^neo-cucumber$/,
        replacement: resolve(import.meta.dirname, "src/public.ts"),
      },
      {
        find: /^neo-cucumber\/style\.css$/,
        replacement: resolve(import.meta.dirname, "src/App.css"),
      },
    ],
  },
  plugins: [
    react({ plugins: [["@lingui/swc-plugin", {}]] }),
    tailwindcss(),
    lingui(),
  ],
  build: {
    outDir: "dist-offline",
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "../frontend/painter/entry.ts"),
      formats: ["es"],
      fileName: () => "offline.js",
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith(".css"))
            ? "offline.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
