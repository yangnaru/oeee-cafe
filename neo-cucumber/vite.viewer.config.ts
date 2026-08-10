import { defineConfig } from "vite";
import path from "node:path";

/**
 * Builds the replay viewer as a standalone script for server-rendered pages,
 * the same way neo.js was consumed. Kept separate from the app build so the
 * viewer does not drag in React, Lingui, Sentry or the collaborative client --
 * a page that only plays a drawing should not pay for a painter.
 *
 * Emits a stable filename; the templates cache-bust it themselves.
 */
export default defineConfig({
  build: {
    outDir: "dist-viewer",
    emptyOutDir: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/viewer/embed.ts"),
      name: "OeeeReplay",
      formats: ["iife"],
      fileName: () => "oeee-replay.js",
    },
  },
});
