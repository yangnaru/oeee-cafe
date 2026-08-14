import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
import Painter from "./Painter";
import { DefaultI18n } from "./components/DefaultI18n";
import { setupI18n } from "./utils/i18n";
import { installNeoGround } from "./neo/neoBackground";
import type { ImageSource, PainterError, PainterHandle } from "./public";

export function mountOfflinePainter(
  element: HTMLElement,
  config: import("./public").PainterOptions,
): PainterHandle {
  if (
    !Number.isInteger(config.width) ||
    !Number.isInteger(config.height) ||
    config.width < 1 ||
    config.width > 1000 ||
    config.height < 1 ||
    config.height > 800
  ) {
    const error = new Error(
      "Painter dimensions must be integers between 1×1 and 1000×800",
    ) as PainterError;
    error.code = "invalid-options";
    throw error;
  }

  setupI18n(config.locale || "en");
  installNeoGround();

  let mounted = true;
  let controller: PainterHandle | null = null;
  let resolveReady = () => {};
  let rejectReady: (reason?: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const unmountedError = (): PainterError => {
    const error = new Error("Painter has been unmounted") as PainterError;
    error.code = "unmounted";
    return error;
  };

  const liveController = async (): Promise<PainterHandle> => {
    await ready;
    if (!mounted || !controller) throw unmountedError();
    return controller;
  };

  const synchronousController = (): PainterHandle => {
    if (!mounted) throw unmountedError();
    if (!controller) {
      const error = new Error("Painter is not ready") as PainterError;
      error.code = "internal";
      throw error;
    }
    return controller;
  };

  const root = createRoot(element);
  root.render(
    <StrictMode>
      <I18nProvider i18n={i18n} defaultComponent={DefaultI18n}>
        <Painter
          ref={(value) => {
            controller = value;
            if (value) {
              void value.ready.then(resolveReady, rejectReady);
            }
          }}
          config={config}
        />
      </I18nProvider>
    </StrictMode>,
  );

  return {
    ready,
    async save() {
      return (await liveController()).save();
    },
    async exportPng() {
      return (await liveController()).exportPng();
    },
    async exportReplay() {
      return (await liveController()).exportReplay();
    },
    async loadImage(source: ImageSource) {
      return (await liveController()).loadImage(source);
    },
    undo() {
      synchronousController().undo();
    },
    redo() {
      synchronousController().redo();
    },
    setInteractionEnabled(enabled: boolean) {
      synchronousController().setInteractionEnabled(enabled);
    },
    async applyCanonicalOperation(operation) {
      return (await liveController()).applyCanonicalOperation(operation);
    },
    async exportCheckpoint(sequence) {
      return (await liveController()).exportCheckpoint(sequence);
    },
    async applyCheckpoint(checkpoint) {
      return (await liveController()).applyCheckpoint(checkpoint);
    },
    async exportSessionArchive() {
      return (await liveController()).exportSessionArchive();
    },
    async compactCanonicalHistory(sequence) {
      return (await liveController()).compactCanonicalHistory(sequence);
    },
    isSynchronizationSettled() {
      return synchronousController().isSynchronizationSettled();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      controller = null;
      rejectReady(unmountedError());
      root.unmount();
    },
  };
}
