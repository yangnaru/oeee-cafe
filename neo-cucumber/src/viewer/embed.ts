/**
 * Standalone replay viewer, mounted straight into a server-rendered page the
 * way neo.js was.
 *
 * Deliberately free of React, Lingui and the rest of the collaborative app:
 * NeoPainter, NeoReplay and ReplayPlayer are all plain TypeScript, so a page
 * that only wants to watch a drawing does not have to download a painter and a
 * WebSocket client to do it.
 */
import { decodePCH } from "../neo/NeoReplay";
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

type Labels = Record<string, string>;

const STRINGS: Record<string, Labels> = {
  en: {
    play: "Play", pause: "Pause", rewind: "Rewind", skip: "Skip to end",
    seek: "Seek", loading: "Loading replay…",
    failed: "This drawing's replay could not be loaded.",
  },
  ko: {
    play: "재생", pause: "일시정지", rewind: "처음으로", skip: "끝으로",
    seek: "탐색", loading: "리플레이 불러오는 중…",
    failed: "이 그림의 리플레이를 불러올 수 없습니다.",
  },
  ja: {
    play: "再生", pause: "一時停止", rewind: "最初から", skip: "最後まで",
    seek: "シーク", loading: "リプレイを読み込み中…",
    failed: "この絵のリプレイを読み込めませんでした。",
  },
  zh: {
    play: "播放", pause: "暂停", rewind: "重新开始", skip: "跳到结尾",
    seek: "跳转", loading: "正在加载回放…",
    failed: "无法加载这幅画的回放。",
  },
};

function labelsFor(lang: string | undefined): Labels {
  const tag = (lang || document.documentElement.lang || "en").toLowerCase();
  return STRINGS[tag.split("-")[0]] ?? STRINGS.en;
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
 * Renders a replay viewer into `container`. Styling hangs off `oeee-replay-*`
 * class names so the host page keeps control of the look.
 */
export function mount(
  container: HTMLElement,
  options: MountOptions
): MountedViewer {
  const labels = labelsFor(options.lang);
  container.classList.add("oeee-replay");
  container.textContent = "";

  const status = el("p", "oeee-replay-status", labels.loading);
  container.appendChild(status);

  const canvas = el("canvas", "oeee-replay-canvas");
  canvas.width = options.width ?? 300;
  canvas.height = options.height ?? 300;

  const controls = el("div", "oeee-replay-controls");
  const seek = el("input", "oeee-replay-seek") as HTMLInputElement;
  seek.type = "range";
  seek.min = "0";
  seek.value = "0";
  seek.setAttribute("aria-label", labels.seek);

  const buttons = el("div", "oeee-replay-buttons");
  const playButton = el("button", "oeee-replay-button", labels.play);
  playButton.type = "button";
  const rewindButton = el("button", "oeee-replay-button", labels.rewind);
  rewindButton.type = "button";
  const skipButton = el("button", "oeee-replay-button", labels.skip);
  skipButton.type = "button";

  const speeds = el("div", "oeee-replay-speeds");
  const speedButtons = SPEEDS.map((speed, index) => {
    const button = el("button", "oeee-replay-speed", speed.label);
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
