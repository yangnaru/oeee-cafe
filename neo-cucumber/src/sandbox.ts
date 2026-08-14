import { mount as mountPainter } from "./public";
import { mount as mountViewer, type MountedViewer } from "./viewer/embed";
import "./viewer/viewer.css";

const painterElement = document.getElementById("painter")!;
const viewerElement = document.getElementById("viewer")!;
const statusElement = document.getElementById("status")!;
const openInput = document.getElementById("open") as HTMLInputElement;

const painter = mountPainter(painterElement, {
  width: 300,
  height: 300,
  locale: "en",
  mode: { kind: "standard" },
  controls: { kind: "toolbox" },
});

let viewer: MountedViewer | null = null;
let replayUrl: string | null = null;

function clearViewer(): void {
  viewer?.dispose();
  viewer = null;
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replayUrl = null;
}

async function showReplay(blob: Blob, width: number, height: number): Promise<void> {
  clearViewer();
  replayUrl = URL.createObjectURL(blob);
  viewer = mountViewer(viewerElement, { replay: replayUrl, width, height });
  statusElement.textContent = `${width}×${height}, ${blob.size.toLocaleString()} bytes`;
}

document.getElementById("replay")!.addEventListener("click", () => {
  void painter.save().then(({ replay, width, height }) =>
    showReplay(replay, width, height),
  );
});

document.getElementById("download")!.addEventListener("click", () => {
  void painter.exportReplay().then((replay) => {
    const url = URL.createObjectURL(replay);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sandbox.pch";
    anchor.click();
    URL.revokeObjectURL(url);
  });
});

openInput.addEventListener("change", () => {
  const file = openInput.files?.[0];
  if (!file) return;
  void file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12 || new TextDecoder().decode(bytes.slice(0, 4)) !== "NEO ") {
      throw new Error("Not a NEO replay");
    }
    return showReplay(file, bytes[4] | (bytes[5] << 8), bytes[6] | (bytes[7] << 8));
  }).catch((error) => {
    statusElement.textContent = String(error);
  });
});

void painter.ready.catch((error) => {
  statusElement.textContent = String(error);
});
