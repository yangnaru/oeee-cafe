import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { lingui } from "@lingui/vite-plugin";

// https://vite.dev/config/
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/collaborate/",
  server: {
    allowedHosts: true,
  },
  plugins: [
    react({
      plugins: [["@lingui/swc-plugin", {}]],
    }),
    tailwindcss(),
    lingui(),
  ],
  build: {
    rollupOptions: {
      input: {
        // The app itself, and the local painter sandbox. The sandbox is a
        // test harness rather than a route -- nothing links to it, and the
        // painter only wires itself to it when ?sandbox is present.
        index: resolve(__dirname, "index.html"),
        sandbox: resolve(__dirname, "sandbox.html"),
      },
    },
  },
});
