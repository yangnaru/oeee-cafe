/**
 * Standalone replay viewer, mounted straight into a server-rendered page the
 * way neo.js was.
 *
 * Deliberately free of React and the rest of the collaborative app: NeoPainter,
 * NeoReplay and ReplayPlayer are all plain TypeScript, so a page that only
 * wants to watch a drawing does not have to download a painter and a WebSocket
 * client to do it.
 *
 * It does carry Lingui's runtime, because its handful of labels belong in the
 * catalogs with every other string here rather than in a table of their own.
 * That costs about 2kB gzipped, against a second place to translate -- which is
 * how a string comes to be forgotten. Its catalog is its own, though; see
 * ./i18n.
 */
import { decodePCH } from "../neo/NeoReplay";
import { labelsFor } from "./i18n";
import {
  DEFAULT_SPEED_INDEX,
  ReplayPlayer,
  SPEEDS,
  type PlayerState,
} from "./ReplayPlayer";

export interface MountOptions {
  /** URL of the .pch file. */
  replay: string;
  /** Fallback canvas size, used until the file's own header is read. */
  width?: number;
  height?: number;
  /** BCP-47 language tag; defaults to the document's. */
  lang?: string;
}

export interface MountedViewer {
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders a replay viewer into `container`. Styling hangs off `neo-cucumber-replay-*`
 * class names so the host page keeps control of the look.
 */
export function mount(
  container: HTMLElement,
  options: MountOptions
): MountedViewer {
  const labels = labelsFor(options.lang);
  container.classList.add("neo-cucumber-replay");
  container.textContent = "";

  const status = el("p", "neo-cucumber-replay-status", labels.loading);
  container.appendChild(status);

  const canvas = el("canvas", "neo-cucumber-replay-canvas");
  canvas.width = options.width ?? 300;
  canvas.height = options.height ?? 300;

  const controls = el("div", "neo-cucumber-replay-controls");
  const seek = el("input", "neo-cucumber-replay-seek") as HTMLInputElement;
  seek.type = "range";
  seek.min = "0";
  seek.value = "0";
  seek.setAttribute("aria-label", labels.seek);

  const buttons = el("div", "neo-cucumber-replay-buttons");
  const playButton = el("button", "neo-cucumber-replay-button", labels.play);
  playButton.type = "button";
  const rewindButton = el("button", "neo-cucumber-replay-button", labels.rewind);
  rewindButton.type = "button";
  const skipButton = el("button", "neo-cucumber-replay-button", labels.skip);
  skipButton.type = "button";

  const speeds = el("div", "neo-cucumber-replay-speeds");
  const speedButtons = SPEEDS.map((speed, index) => {
    const button = el("button", "neo-cucumber-replay-speed", speed.label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(index === DEFAULT_SPEED_INDEX));
    speeds.appendChild(button);
    return button;
  });

  buttons.append(playButton, rewindButton, skipButton, speeds);
  controls.append(seek, buttons);

  let player: ReplayPlayer | null = null;
  let disposed = false;

  const onState = (state: PlayerState) => {
    seek.max = String(Math.max(1, state.total));
    seek.value = String(state.position);
    playButton.textContent = state.playing ? labels.pause : labels.play;
  };

  (async () => {
    try {
      const response = await fetch(options.replay);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoded = decodePCH(await response.arrayBuffer());
      if (!decoded) throw new Error("not a PCH file");
      if (disposed) return;

      canvas.width = decoded.width;
      canvas.height = decoded.height;
      canvas.style.width = `${decoded.width}px`;
      canvas.style.height = `${decoded.height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");

      status.remove();
      container.append(canvas, controls);

      player = new ReplayPlayer(
        decoded.items,
        decoded.width,
        decoded.height,
        ctx,
        onState
      );
      player.play();
    } catch (error) {
      if (disposed) return;
      status.textContent = `${labels.failed} (${
        error instanceof Error ? error.message : String(error)
      })`;
    }
  })();

  playButton.addEventListener("click", () => {
    if (!player) return;
    if (player.getState().playing) player.pause();
    else player.play();
  });
  rewindButton.addEventListener("click", () => void player?.rewind());
  skipButton.addEventListener("click", () => void player?.skipToEnd());
  seek.addEventListener("input", () => void player?.seekTo(Number(seek.value)));

  speedButtons.forEach((button, index) => {
    button.addEventListener("click", () => {
      player?.setSpeed(SPEEDS[index].rate);
      speedButtons.forEach((other, i) =>
        other.setAttribute("aria-pressed", String(i === index))
      );
    });
  });

  return {
    dispose() {
      disposed = true;
      player?.dispose();
      player = null;
      container.textContent = "";
    },
  };
}
