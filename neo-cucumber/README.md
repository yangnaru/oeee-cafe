# neo-cucumber

NEO-compatible drawing canvas used by oeee-cafe for offline, collaborative,
two-tone, relay, banner, and replay workflows.

## Library boundary

The public contract is defined in [`src/public.ts`](src/public.ts). The canvas
internals and imperative mount implement this lifecycle and are distributed as
the package's root export.

The library's core is the drawing canvas and this lifecycle:

```ts
import { mount } from "neo-cucumber";
import "neo-cucumber/style.css";

const painter = mount(element, {
  width: 640,
  height: 480,
  mode: { kind: "standard" },
  controls: { kind: "toolbox" },
});

await painter.ready;
await painter.loadImage(parentImage);

const { png, replay, strokeCount } = await painter.save();
painter.unmount();
```

`save()` is an atomic local export. It never uploads, redirects, or calls a
native bridge. Hosts own persistence and completion behavior.

The built-in toolbox is an optional maintained preset. Its React components,
props, drawing state, and callbacks are not part of the public API. Consumers
that do not request it receive the canvas alone.

## Contract principles

- No React types in the public interface.
- No oeee-cafe routes, identifiers, submission formats, or native bridge.
- Standard and two-tone behavior are core canvas modes.
- Continuation images are core through `loadImage()` and are self-contained in
  exported `.pch` files by default.
- PNG and replay exports do not mutate visible artwork.
- `unmount()` is idempotent and all later asynchronous operations reject.
- Public compatibility applies only to exports from `src/public.ts` once a
  package build is introduced.

## Current application builds

```bash
pnpm run build
```

This builds the collaborative application, replay viewer, oeee-cafe's offline
auto-mounting adapter, and the package in `dist-lib/`. The host-specific adapter
lives outside the library source at
[`../frontend/painter/entry.ts`](../frontend/painter/entry.ts).

[`sandbox.html`](sandbox.html) is the library usage example. It mounts the
painter through `src/public.ts`, opts into the built-in toolbox, exports PNG and
replay data, and opens the replay viewer without relying on private components.

The package exposes only `neo-cucumber` and `neo-cucumber/style.css`. React and
React DOM are peer dependencies; private canvas and toolbox modules are not
package exports.
