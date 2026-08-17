import { describe, expect, it } from "vitest";
import { materialSymbols } from "./materialSymbols";

/*
 * The bundled collection is generated from the names the sources mention, and
 * nothing at build time notices when the two drift apart: an icon that is not
 * bundled still renders, just a network round trip late -- and not at all in
 * the offline bundle, which has no server to ask. That failure only shows up
 * on someone's screen, so it is checked here instead.
 */
const sources: Record<string, string> = {
  ...import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../frontend/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

describe("bundled Material Symbols", () => {
  it("covers every icon the sources ask for, and nothing else", () => {
    const referenced = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const [, name] of source.matchAll(/material-symbols:([a-z0-9-]+)/g)) {
        referenced.add(name);
      }
    }

    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].sort()).toEqual(
      // Out of date? Run `pnpm run build:icons`.
      Object.keys(materialSymbols.icons).sort(),
    );
  });

  it("carries artwork rather than names", () => {
    for (const [name, icon] of Object.entries(materialSymbols.icons)) {
      expect(icon.body, name).toMatch(/^<path /);
    }
  });
});
