import { useCallback, useRef, useState } from "react";
import OfflineApp from "../OfflineApp";
import { mount, type MountedViewer } from "../viewer/embed";
import { sandboxBridge } from "./bridge";
import "../viewer/viewer.css";
import "../styles/neoChrome.css";

/**
 * Local test harness: draw, then replay what you drew.
 *
 * The replay is played from the *same bytes* the painter would have uploaded,
 * handed to the same viewer the site embeds -- so a divergence between canvas
 * and replay shows up here rather than after a post.
 */
export function SandboxPage() {
  const viewerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedViewer | null>(null);
  const urlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const teardown = useCallback(() => {
    mountedRef.current?.dispose();
    mountedRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const replay = useCallback(async () => {
    const container = viewerRef.current;
    if (!container) return;
    if (!sandboxBridge.getReplayBlob) {
      setStatus("The painter has not started yet.");
      return;
    }

    teardown();
    setStatus(null);

    // The restore frame is what a real save appends, so append it here too --
    // its absence is exactly the kind of bug this page exists to catch.
    await sandboxBridge.addRestoreAction?.();
    const blob = sandboxBridge.getReplayBlob();
    if (blob.size <= 12) {
      setStatus("Nothing recorded yet — draw something first.");
      return;
    }

    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    mountedRef.current = mount(container, {
      replay: url,
      width: sandboxBridge.width,
      height: sandboxBridge.height,
    });
    setStatus(`${blob.size.toLocaleString()} bytes`);
  }, [teardown]);

  const download = useCallback(() => {
    if (!sandboxBridge.getReplayBlob) return;
    const blob = sandboxBridge.getReplayBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sandbox.pch";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="relative">
      <OfflineApp />

      {/* The painter fills the viewport, so these ride above it rather than
          sitting underneath where they cannot be seen. */}
      <div className="neo-chrome fixed bottom-0 left-0 right-0 z-[60] max-h-[60vh] overflow-y-auto border-t border-neutral-400 p-2">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={replay}
            className="px-3 py-1 text-sm"
          >
            Replay what I drew
          </button>
          <button
            type="button"
            onClick={download}
            className="px-3 py-1 text-sm"
          >
            Download .pch
          </button>
          {status && (
            <span className="text-xs opacity-70">{status}</span>
          )}
        </div>
        <div ref={viewerRef} />
      </div>
    </div>
  );
}
