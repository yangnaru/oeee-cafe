import { mountOfflinePainter } from "./mountOfflinePainter";

export type {
  CanonicalPainterOperation,
  LocalPainterOperation,
  PainterBrush,
  PainterCheckpoint,
  PainterColor,
  PainterLayer,
  PainterMask,
  PainterOperation,
  PainterPoint,
  PainterRegionTool,
  PainterSessionArchive,
} from "./operations";

/**
 * Public API for neo-cucumber.
 *
 * This file is deliberately host- and framework-neutral. It is the contract
 * exported by the package. Canvas and toolbox implementation details are not
 * package exports.
 */

/** The painter behavior, independent of whichever controls render around it. */
export type PainterMode =
  | { kind: "standard" }
  | {
      kind: "two-tone";
      backgroundColor: string;
      foregroundColor: string;
    };

/**
 * Optional controls supplied by neo-cucumber.
 *
 * The toolbox itself is intentionally not a public component API. Consumers
 * may opt into the maintained preset, or mount only the drawing canvas.
 */
export type PainterControls =
  | { kind: "none" }
  | { kind: "toolbox" };

export interface PainterOptions {
  /** Integer dimensions: width 1–1024 and height 1–800. */
  width: number;
  height: number;
  mode: PainterMode;
  controls: PainterControls;
  /** BCP 47 language tag used by prebuilt controls. */
  locale?: string;
  /** Called after the pixels or replay history change. */
  onChange?: (state: PainterChange) => void;
  /** Called for asynchronous errors that cannot be returned to the caller. */
  onError?: (error: PainterError) => void;
  /** Optional controlled-operation sink used by collaborative hosts. */
  synchronization?: {
    actorId: string;
    onOperation(operation: import("./operations").LocalPainterOperation): void;
    /** Ephemeral canvas-space hover position, or null after leaving. */
    onPointerMove?: (position: import("./operations").PainterPoint | null) => void;
    /** Called when a pointer stroke ends so hosts can retire remote cursors. */
    onPointerUp?: () => void;
  };
}

export interface PainterChange {
  canUndo: boolean;
  canRedo: boolean;
  strokeCount: number;
  dirty: boolean;
}

export type PainterErrorCode =
  | "invalid-options"
  | "image-load-failed"
  | "export-failed"
  | "unmounted"
  | "internal";

export interface PainterError extends Error {
  code: PainterErrorCode;
  cause?: unknown;
}

/** A URL, URL string, or browser-owned image bytes. */
export type ImageSource = URL | string | Blob;

export interface PainterExport {
  png: Blob;
  replay: Blob;
  width: number;
  height: number;
  strokeCount: number;
}

/**
 * Stable lifecycle owned by neo-cucumber rather than React.
 * Every async method rejects with PainterError after unmounting.
 */
export interface PainterHandle {
  /** Resolves after canvases, history, and optional controls are ready. */
  readonly ready: Promise<void>;

  /**
   * Capture PNG and replay atomically from one canvas state.
   * This does not perform network I/O.
   */
  save(): Promise<PainterExport>;

  /** Export the composited artwork without changing replay history. */
  exportPng(): Promise<Blob>;

  /** Export a NEO-compatible .pch without changing the visible canvas. */
  exportReplay(): Promise<Blob>;

  /**
   * Load artwork into a layer. Hosts should await `ready` first.
   * Loading before the first user edit is the supported continuation flow.
   */
  loadImage(source: ImageSource): Promise<void>;

  /** Undo or redo through the painter's active history policy. */
  undo(): void;
  redo(): void;

  /** Enable or suspend pointer-driven editing without unmounting the painter. */
  setInteractionEnabled(enabled: boolean): void;

  /** Apply a server-ordered echo or remote operation in controlled mode. */
  applyCanonicalOperation(
    operation: import("./operations").CanonicalPainterOperation,
  ): Promise<void>;

  /** Capture both editable layers at a canonical compaction boundary. */
  exportCheckpoint(sequence: number): Promise<import("./operations").PainterCheckpoint>;

  /** Replace both editable layers and reset controlled history to a checkpoint. */
  applyCheckpoint(checkpoint: import("./operations").PainterCheckpoint): Promise<void>;

  /** Export the canonical log since the last applied checkpoint. */
  exportSessionArchive(): Promise<import("./operations").PainterSessionArchive>;

  /** Compact confirmed history through a server-approved canonical sequence. */
  compactCanonicalHistory(sequence: number): Promise<void>;

  /** True when no pointer gesture or optimistic operation is outstanding. */
  isSynchronizationSettled(): boolean;

  /** Idempotently release listeners, canvases, controls, and framework roots. */
  unmount(): void;
}

/** The framework-neutral library shape. */
export interface NeoCucumberLibrary {
  mount(element: HTMLElement, options: PainterOptions): PainterHandle;
}

export const mount: NeoCucumberLibrary["mount"] = mountOfflinePainter;
