import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { decodePCH } from "../neo/NeoReplay";
import {
  DEFAULT_SPEED_INDEX,
  ReplayPlayer,
  SPEEDS,
  type PlayerState,
} from "./ReplayPlayer";
import "../App.css";

type Status = "loading" | "ready" | "error";

function ViewerApp() {
  const { t } = useLingui();

  const { replayUrl, fallbackWidth, fallbackHeight } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      replayUrl: params.get("replay"),
      fallbackWidth: Number(params.get("width")) || 300,
      fallbackHeight: Number(params.get("height")) || 300,
    };
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");
  const [size, setSize] = useState({ w: fallbackWidth, h: fallbackHeight });
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
  const [state, setState] = useState<PlayerState>({
    position: 0,
    total: 0,
    playing: false,
    finished: false,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!replayUrl) {
        setError(t`No replay to show.`);
        setStatus("error");
        return;
      }

      try {
        const response = await fetch(replayUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const decoded = decodePCH(await response.arrayBuffer());
        if (!decoded) throw new Error("not a PCH file");
        if (cancelled) return;

        setSize({ w: decoded.width, h: decoded.height });
        setStatus("ready");

        // Wait for the canvas element to exist at its final size
        requestAnimationFrame(() => {
          if (cancelled) return;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;

          playerRef.current?.dispose();
          const player = new ReplayPlayer(
            decoded.items,
            decoded.width,
            decoded.height,
            ctx,
            setState
          );
          playerRef.current = player;
          player.setSpeed(SPEEDS[DEFAULT_SPEED_INDEX].delay);
          player.play();
        });
      } catch (e) {
        if (cancelled) return;
        setError(
          t`This drawing's replay could not be loaded.` +
            ` (${e instanceof Error ? e.message : String(e)})`
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [replayUrl, t]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.getState().playing) player.pause();
    else player.play();
  }, []);

  const handleSpeed = useCallback((index: number) => {
    setSpeedIndex(index);
    playerRef.current?.setSpeed(SPEEDS[index].delay);
  }, []);

  if (status === "error") {
    return (
      <div className="p-4 text-main">
        <p>{error}</p>
      </div>
    );
  }

  const pct = state.total > 0 ? (state.position / state.total) * 100 : 0;

  return (
    <div className="flex flex-col items-center gap-2 p-2 bg-main text-main">
      <div
        className="border border-main bg-white"
        style={{ width: size.w, height: size.h }}
      >
        <canvas
          ref={canvasRef}
          width={size.w}
          height={size.h}
          style={{ width: size.w, height: size.h, display: "block" }}
        />
      </div>

      {status === "loading" ? (
        <p className="text-sm">
          <Trans>Loading replay...</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-2" style={{ width: size.w }}>
          <input
            type="range"
            min={0}
            max={Math.max(1, state.total)}
            value={state.position}
            onChange={(e) => void playerRef.current?.seekTo(Number(e.target.value))}
            aria-label={t`Seek`}
            className="w-full cursor-pointer"
          />

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={togglePlay}
              className="px-3 py-1 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white"
            >
              {state.playing ? <Trans>Pause</Trans> : <Trans>Play</Trans>}
            </button>
            <button
              type="button"
              onClick={() => void playerRef.current?.rewind()}
              className="px-3 py-1 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white"
            >
              <Trans>Rewind</Trans>
            </button>
            <button
              type="button"
              onClick={() => void playerRef.current?.skipToEnd()}
              className="px-3 py-1 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white"
            >
              <Trans>Skip to end</Trans>
            </button>

            <span className="ml-auto flex items-center gap-1">
              {SPEEDS.map((speed, index) => (
                <button
                  key={speed.label}
                  type="button"
                  onClick={() => handleSpeed(index)}
                  aria-pressed={index === speedIndex}
                  className={`px-2 py-1 border border-main cursor-pointer ${
                    index === speedIndex
                      ? "bg-highlight text-white"
                      : "bg-main text-main hover:bg-highlight hover:text-white"
                  }`}
                >
                  {speed.label}
                </button>
              ))}
            </span>
          </div>

          <div className="text-xs text-main">
            {Math.round(pct)}% &middot;{" "}
            <Trans>
              step {state.position} of {state.total}
            </Trans>
          </div>
        </div>
      )}
    </div>
  );
}

export default ViewerApp;
