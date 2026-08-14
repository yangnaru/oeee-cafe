import {
  mount,
  type PainterMode,
  type PainterHandle,
} from "neo-cucumber";

interface OeeePainterConfig {
  width: number;
  height: number;
  locale?: string;
  communityId?: string | null;
  parentPostId?: string | null;
  initialImageUrl?: string | null;
  submission?:
    | { kind: "post" }
    | { kind: "banner"; profileUrl: string };
  mode: PainterMode;
}

interface NativeMessage {
  type: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        oeee?: { postMessage(message: NativeMessage): void };
      };
    };
    OeeeCafe?: { postMessage(message: string): void };
  }
}

function nativeAvailable(): boolean {
  return Boolean(
    window.webkit?.messageHandlers?.oeee || window.OeeeCafe?.postMessage,
  );
}

function postNative(message: NativeMessage): void {
  if (window.webkit?.messageHandlers?.oeee) {
    window.webkit.messageHandlers.oeee.postMessage(message);
  } else if (window.OeeeCafe?.postMessage) {
    window.OeeeCafe.postMessage(JSON.stringify(message));
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read PNG"));
    reader.readAsDataURL(blob);
  });
}

async function submit(
  painter: PainterHandle,
  config: OeeePainterConfig,
  startedAt: number,
): Promise<void> {
  const snapshot = await painter.save();
  const form = new FormData();
  form.append("image", await blobToDataUrl(snapshot.png));
  form.append("animation", snapshot.replay);
  form.append("width", String(snapshot.width));
  form.append("height", String(snapshot.height));
  form.append("security_timer", String(startedAt));
  form.append("security_count", String(snapshot.strokeCount));

  const submission = config.submission ?? { kind: "post" as const };
  if (submission.kind === "post") {
    form.append(
      "tool",
      config.mode.kind === "two-tone" ? "cucumber" : "neo-cucumber-offline",
    );
    if (config.communityId) form.append("community_id", config.communityId);
    if (config.parentPostId) form.append("parent_post_id", config.parentPostId);
  }

  const response = await fetch(
    submission.kind === "banner" ? "/banners/draw/finish" : "/draw/finish",
    { method: "POST", body: form },
  );
  const result = await response.json();
  if (!response.ok || result?.error) {
    throw new Error(result?.error ?? `Upload failed: ${response.status}`);
  }

  if (submission.kind === "banner") {
    if (nativeAvailable()) {
      postNative({
        type: "banner_complete",
        bannerId: result.banner_id,
        imageUrl: result.image_url,
      });
    } else {
      window.location.href = submission.profileUrl;
    }
  } else if (nativeAvailable()) {
    postNative({
      type: "drawing_complete",
      postId: result.post_id,
      communityId: result.community_id,
      imageUrl: result.image_url,
    });
  } else {
    window.location.href = `/posts/${result.post_id}/publish`;
  }
}

const root = document.getElementById("neo-cucumber-root");
const configElement = document.getElementById("neo-cucumber-config");
const saveButton = document.getElementById("oeee-painter-save") as HTMLButtonElement | null;

if (!root || !configElement?.textContent || !saveButton) {
  throw new Error("Oeee painter host is missing its root, configuration, or Save button");
}
const painterRoot = root;
const pageSaveButton = saveButton;

const config = JSON.parse(configElement.textContent) as OeeePainterConfig;
const startedAt = Date.now();
const painter = mount(root, {
  width: config.width,
  height: config.height,
  locale: config.locale,
  mode: config.mode,
  controls: { kind: "toolbox" },
});

function movePageActionsIntoExtraToolbox(): void {
  const colorInput = painterRoot.querySelector<HTMLInputElement>(
    'input[type="color"]',
  );
  const extraTools = colorInput?.parentElement;
  const helpButton = painterRoot.querySelector<HTMLButtonElement>(
    'button[aria-label="Keyboard shortcuts"]',
  );
  const toolboxButton =
    extraTools?.querySelector<HTMLButtonElement>("button.w-full");
  if (!extraTools || !helpButton || !toolboxButton) {
    throw new Error("Oeee painter could not find the extra toolbox actions");
  }

  // Reuse neo-cucumber's own full-width toolbox styling without changing its
  // public API or moving React-owned DOM. The proxy activates the original
  // hidden Help button, which keeps React's tree intact when the dialog opens.
  const helpProxy = document.createElement("button");
  helpProxy.type = "button";
  helpProxy.className = toolboxButton.className;
  helpProxy.textContent = "Help";
  helpProxy.title = helpButton.title;
  helpProxy.setAttribute("aria-label", helpButton.getAttribute("aria-label") ?? "Help");
  helpProxy.addEventListener("click", () => helpButton.click());
  helpButton.hidden = true;
  pageSaveButton.className = toolboxButton.className;
  pageSaveButton.removeAttribute("style");
  extraTools.append(helpProxy, pageSaveButton);
}

void painter.ready
  .then(async () => {
    if (config.initialImageUrl) await painter.loadImage(config.initialImageUrl);
    if (config.mode.kind === "standard") movePageActionsIntoExtraToolbox();
    saveButton.disabled = false;
  })
  .catch((error) => {
    console.error(error);
    alert("Failed to start the painter.");
  });

saveButton.addEventListener("click", () => {
  saveButton.disabled = true;
  void submit(painter, config, startedAt).catch((error) => {
    console.error(error);
    alert("Failed to save drawing. Please try again.");
    saveButton.disabled = false;
  });
});
