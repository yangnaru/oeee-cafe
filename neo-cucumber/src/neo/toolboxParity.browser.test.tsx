import { beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
// Our own stylesheet, so the column renders with the utilities it ships with
// rather than with the browser's defaults
import "../App.css";
import neoScript from "../../../neo/dist/paintbbs-oeee-1.7.0.js?raw";
import neoStyles from "../../../neo/dist/paintbbs-oeee-1.7.0.css?raw";
import { NeoToolColumn } from "../components/neo/NeoToolColumn";
import { ALL_TOOLS, DEFAULT_PALETTE_COLORS } from "../constants/drawing";
import type { DrawingState } from "../types/collaboration";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The toolbox, checked against PaintBBS NEO itself.
 *
 * Every other claim about this column has been a screenshot and a careful
 * reading, and both have missed things: an eighth button that looked like it
 * belonged, colours transcribed in the wrong byte order, widgets two pixels
 * short because a CSS reset changed what their numbers meant. So this boots
 * the real NEO 1.7.0 bundle in the same page, renders our column beside it,
 * and compares what the browser actually computed for each.
 *
 * A failure here means we have diverged from NEO -- which is sometimes the
 * right thing to do, but never the right thing to do silently.
 */

const W = 300;
const H = 300;

/** What we compare: what each widget is, where it sits, and how it looks. */
interface Widget {
  kind: string;
  label: string;
  /** Relative to the first widget, so the two columns' origins need not agree. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  background: string;
  borderTop: string;
  borderRight: string;
  boxShadow: string;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The shadow layers that actually paint.
 *
 * Tailwind composes box-shadow out of several variables, so a single ring
 * serialises with four fully transparent layers ahead of it. A layer with a
 * transparent colour draws nothing whatever its geometry, so dropping those
 * compares what is on screen rather than how the browser wrote it down.
 */
function effectiveShadow(shadow: string): string {
  if (shadow === "none") return "none";

  // Split on commas outside parentheses: the colours contain commas too
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of shadow) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) layers.push(current.trim());

  const painted = layers.filter((l) => !/rgba\([^)]*,\s*0\)/.test(l));
  return painted.length ? painted.join(", ") : "none";
}

function describeBox(el: Element, origin: DOMRect, kind: string, label: string) {
  const r = el.getBoundingClientRect();
  const cs = styleOf(el);
  return {
    kind,
    label,
    dx: round(r.x - origin.x),
    dy: round(r.y - origin.y),
    w: round(r.width),
    h: round(r.height),
    background: cs.backgroundColor,
    borderTop: `${cs.borderTopWidth} ${cs.borderTopColor}`,
    borderRight: `${cs.borderRightWidth} ${cs.borderRightColor}`,
    boxShadow: effectiveShadow(cs.boxShadow),
  };
}

/*
  -------------------------------------------------------------------------
    Booting the reference
  -------------------------------------------------------------------------
*/

let neoColumn: HTMLElement;

function bootNeo(): HTMLElement {
  // A restore prompt would block the boot on a confirm dialog
  localStorage.clear();

  /*
   * NEO gets its own document.
   *
   * Our stylesheet sets `box-sizing: border-box` on everything, and NEO
   * predates that: sharing a document silently squeezed its 46x18 tips into
   * 46x18 *including* their border, so the reference came out two pixels
   * smaller than the real thing and our column looked wrong for matching it.
   * An iframe keeps each side in the environment it actually ships in.
   */
  const frame = document.createElement("iframe");
  frame.width = "800";
  frame.height = "700";
  frame.style.border = "0";
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) throw new Error("no iframe document");

  doc.open();
  doc.write(
    "<!DOCTYPE html><html><head><style>" +
      neoStyles +
      "</style></head><body style='margin:0'>" +
      `<applet-dummy name="paintbbs" width="600" height="500">` +
      `<param name="image_width" value="${W}">` +
      `<param name="image_height" value="${H}">` +
      "</applet-dummy></body></html>"
  );
  doc.close();

  const script = doc.createElement("script");
  script.textContent = neoScript;
  doc.head.appendChild(script);

  // The bundle boots from DOMContentLoaded, which the written document already
  // fired before the script was appended
  const Neo = (doc as unknown as { neo: { init(): boolean; start(): void } }).neo;
  Neo.init();
  Neo.start();

  const toolSet = doc.getElementById("toolSet");
  if (!toolSet) throw new Error("NEO did not build its toolbox");
  return toolSet;
}

/** NEO's column, read off the DOM it built. */
function readNeo(toolSet: HTMLElement): Widget[] {
  const first = toolSet.firstElementChild!.getBoundingClientRect();
  const out: Widget[] = [];

  for (const child of Array.from(toolSet.children)) {
    const id = child.id;
    const cls = child.className;

    if (cls.startsWith("toolTip")) {
      const label = child.querySelector(".label")?.textContent ?? "";
      out.push(describeBox(child, first, "tip", label));
    } else if (cls === "colorTips") {
      out.push(describeBox(child, first, "colorTips", ""));
      for (const tip of Array.from(child.children)) {
        if (tip.tagName === "BR") continue;
        out.push(describeBox(tip, first, "colorTip", swatchColour(tip)));
      }
    } else if (cls === "colorSlider") {
      const label = child.querySelector(".label")?.textContent ?? "";
      out.push(describeBox(child, first, "colorSlider", label));
    } else if (cls === "sizeSlider") {
      const label = child.querySelector(".label")?.textContent ?? "";
      out.push(describeBox(child, first, "sizeSlider", label));
    } else if (cls === "reserveControl") {
      out.push(describeBox(child, first, "reserveControl", ""));
      for (const r of Array.from(child.children)) {
        out.push(describeBox(r, first, "reserve", swatchColour(r)));
      }
    } else if (id === "layerControl") {
      // NEO keeps both labels and hides the one that does not apply
      const shown = Array.from(child.querySelectorAll(".label0, .label1")).find(
        (l) => styleOf(l).display !== "none"
      );
      out.push(describeBox(child, first, "layerControl", shown?.textContent ?? ""));
    } else {
      /*
       * Anything NEO builds that this does not recognise is a widget we have
       * never implemented, and skipping it would let the comparison below
       * pass by simply not looking. Fail loudly instead.
       */
      throw new Error(
        `NEO built a toolbox widget this test does not model: <${child.tagName.toLowerCase()} id="${id}" class="${cls}">`
      );
    }
  }
  return sortByPosition(out);
}

/** Computed style from the element's own document, not necessarily this one. */
function styleOf(el: Element): CSSStyleDeclaration {
  const view = el.ownerDocument.defaultView ?? window;
  return view.getComputedStyle(el);
}

function swatchColour(el: Element): string {
  return styleOf(el).backgroundColor;
}

/** Our column, read the same way. */
function readOurs(column: HTMLElement): Widget[] {
  const first = column.querySelector("button")!.getBoundingClientRect();
  const out: Widget[] = [];

  const tipSet = column.children[0];
  for (const tip of Array.from(tipSet.children)) {
    out.push(describeBox(tip, first, "tip", tip.querySelector("span")?.textContent ?? ""));
  }

  const colorTips = column.children[1];
  out.push(describeBox(colorTips, first, "colorTips", ""));
  for (const tip of Array.from(colorTips.children)) {
    out.push(describeBox(tip, first, "colorTip", swatchColour(tip)));
  }

  const sliders = column.children[2];
  for (const slider of Array.from(sliders.children)) {
    const label = slider.children[1]?.textContent ?? "";
    out.push(describeBox(slider, first, "colorSlider", label));
  }

  const sizeSlider = column.children[3];
  out.push(
    describeBox(sizeSlider, first, "sizeSlider", sizeSlider.children[1]?.textContent ?? "")
  );

  const reserves = column.children[4];
  out.push(describeBox(reserves, first, "reserveControl", ""));
  for (const r of Array.from(reserves.children)) {
    out.push(describeBox(r, first, "reserve", swatchColour(r)));
  }

  const layer = column.children[5];
  const shown = Array.from(layer.querySelectorAll("span")).find(
    (s) => (s.textContent ?? "").length > 0
  );
  out.push(describeBox(layer, first, "layerControl", shown?.textContent ?? ""));

  return sortByPosition(out);
}

/** Reading order, so neither side's DOM order can flatter it. */
function sortByPosition(widgets: Widget[]): Widget[] {
  return [...widgets].sort((a, b) => a.dy - b.dy || a.dx - b.dx);
}

/*
  -------------------------------------------------------------------------
    Rendering ours in NEO's starting state
  -------------------------------------------------------------------------
*/

async function renderOurs(): Promise<HTMLElement> {
  /*
   * Light, explicitly.
   *
   * The column follows the theme now, and only its light values are NEO's --
   * dark is a derivation. Leaving this to the runner would make the assertion
   * depend on whatever colour scheme the machine running CI happens to prefer,
   * which is how a parity test starts failing for reasons that have nothing to
   * do with parity.
   */
  document.documentElement.setAttribute("data-theme", "light");

  const host = document.createElement("div");
  document.body.appendChild(host);

  // Exactly what NEO boots holding: the pen, black, 1px, fully opaque, on the
  // background layer, with its own palette and no mask.
  const state: DrawingState = {
    brushSize: 1,
    opacity: 255,
    color: "#000000",
    brushType: "solid",
    drawType: "freehand",
    maskType: 0,
    maskColor: "#000000",
    layerType: "background",
    zoomLevel: 100,
    fgVisible: true,
    bgVisible: true,
    isFlippedHorizontal: false,
  };

  await act(async () => {
    createRoot(host).render(
      <NeoToolColumn
        drawingState={state}
        paletteColors={[...DEFAULT_PALETTE_COLORS]}
        selectedPaletteIndex={1}
        tools={ALL_TOOLS}
        onUpdateDrawingState={() => {}}
        onUpdateBrushType={() => {}}
        onUpdateColor={() => {}}
        onSetSelectedPaletteIndex={() => {}}
        onSetPaletteColor={() => {}}
      />
    );
  });

  const column = host.firstElementChild as HTMLElement;
  if (!column) throw new Error("our column did not render");
  return column;
}

let ours: Widget[];
let theirs: Widget[];

describe("our toolbox against PaintBBS NEO itself", () => {
  beforeAll(async () => {
    neoColumn = bootNeo();
    theirs = readNeo(neoColumn);
    ours = readOurs(await renderOurs());
  });

  it("boots the reference implementation", () => {
    // Guards the rest: an empty reference would make every test below vacuous
    expect(theirs.length).toBeGreaterThan(20);
  });

  it("has exactly NEO's widgets, in NEO's order", () => {
    expect(ours.map((w) => w.kind)).toEqual(theirs.map((w) => w.kind));
  });

  it("labels them the way NEO labels them", () => {
    expect(ours.map((w) => w.label)).toEqual(theirs.map((w) => w.label));
  });

  it("lays them out where NEO lays them out", () => {
    const geometry = (w: Widget) => `${w.kind} ${w.label}: ${w.dx},${w.dy} ${w.w}x${w.h}`;
    expect(ours.map(geometry)).toEqual(theirs.map(geometry));
  });

  it("gives them NEO's faces, bevels and frames", () => {
    const skin = (w: Widget) =>
      `${w.kind} ${w.label}: bg ${w.background} top ${w.borderTop} right ${w.borderRight} ring ${w.boxShadow}`;
    expect(ours.map(skin)).toEqual(theirs.map(skin));
  });
});
