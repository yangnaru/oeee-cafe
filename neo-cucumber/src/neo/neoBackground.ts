/**
 * NEO's ground, transcribed from Neo.backgroundImage.
 *
 * It is a 16x16 tile filled with `color_bk`, with a single line of `color_bk2`
 * down its fifteenth column and row -- `x == 14 || y == 14`, which is why the
 * grid appears to sit one pixel inside each cell rather than on its edge. NEO
 * builds it on a canvas and hands the data URL to `background-image`, and so
 * does this: a CSS gradient could imitate the result, but the tile is cheap
 * and this way the pixels are NEO's own.
 *
 * It is generated rather than baked because the two colours come from the
 * theme, so a dark ground gets a tile built from its own pair.
 */

/** The tile is 16x16, from NEO's own canvas dimensions. */
const TILE = 16;

/** Where the line falls inside the tile. */
const LINE = 14;

function parseHex(color: string): [number, number, number] {
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

/**
 * A data URL for the tile, or null when there is no canvas to draw on.
 *
 * `background` is NEO's `color_bk` and `line` its `color_bk2`.
 */
export function neoGroundTile(background: string, line: string): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const [br, bg, bb] = parseHex(background);
  const [lr, lg, lb] = parseHex(line);

  const image = ctx.createImageData(TILE, TILE);
  const data = image.data;
  let i = 0;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const onLine = x === LINE || y === LINE;
      data[i] = onLine ? lr : br;
      data[i + 1] = onLine ? lg : bg;
      data[i + 2] = onLine ? lb : bb;
      data[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Reads the two ground colours out of the live theme and publishes the tile as
 * `--neo-ground-image`, so the CSS that uses it does not have to know how it
 * was made. Returns a function that stops watching for theme changes.
 *
 * Watching matters: the tile is pixels, not a colour, so unlike every other
 * token it cannot follow a `prefers-color-scheme` switch on its own.
 */
export function installNeoGround(root: HTMLElement = document.documentElement) {
  const paint = () => {
    const styles = getComputedStyle(root);
    const background = styles.getPropertyValue("--neo-bk").trim();
    const line = styles.getPropertyValue("--neo-bk2").trim();
    if (!background || !line) return;

    const tile = neoGroundTile(background, line);
    if (tile) root.style.setProperty("--neo-ground-image", `url(${tile})`);
  };

  paint();

  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", paint);

  // A [data-theme] flip changes the tokens without touching the media query
  const observer = new MutationObserver(paint);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  return () => {
    scheme.removeEventListener("change", paint);
    observer.disconnect();
  };
}
