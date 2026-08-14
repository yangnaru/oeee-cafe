import { defineConfig } from "@lingui/cli";

export default defineConfig({
  sourceLocale: "en",
  locales: ["ko", "ja", "en", "zh"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
    },
    {
      path: "<rootDir>/../frontend/collaborate/locales/{locale}/messages",
      include: ["../frontend/collaborate"],
    },
  ],
});
