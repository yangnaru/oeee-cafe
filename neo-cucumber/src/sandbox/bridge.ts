/**
 * Lets the sandbox page reach the painter's recorder.
 *
 * Only the sandbox entry imports this, and only the sandbox build fills it in,
 * so the painter carries nothing extra into production.
 */
export interface SandboxBridge {
  getReplayBlob?: () => Blob;
  addRestoreAction?: () => Promise<void>;
  width?: number;
  height?: number;
}

export const sandboxBridge: SandboxBridge = {};

let enabled = false;

/**
 * Turned on by the sandbox entry before it renders. A query parameter would
 * work too, but the sandbox page is always the sandbox -- making it say so
 * beats making every visitor remember to.
 */
export function enableSandbox(): void {
  enabled = true;
}

/** True when the page was opened as the local test harness. */
export const isSandbox = (): boolean =>
  enabled ||
  (typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("sandbox"));
