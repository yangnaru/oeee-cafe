import { defineConfig } from "@lingui/cli";

export default defineConfig({
  sourceLocale: "en",
  locales: ["ko", "ja", "en", "zh"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      // The viewer keeps its own, below.
      exclude: ["**/viewer/**"],
    },
    // The replay viewer ships as a standalone script on every post page, so it
    // carries a catalog of its own rather than the package's whole message set:
    // seven labels against sixty is the difference between a viewer that costs
    // 30kB and one that costs 61kB.
    {
      path: "<rootDir>/src/viewer/locales/{locale}/messages",
      include: ["src/viewer"],
    },
    {
      path: "<rootDir>/../frontend/collaborate/locales/{locale}/messages",
      include: ["../frontend/collaborate"],
    },
  ],
});
