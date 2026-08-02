/**
 * Local fork for optimistic drawing with server reconciliation.
 *
 * Modeled after Drawpile's canvas history local fork: locally drawn messages
 * are applied to the canvas immediately and queued here until the server
 * echoes them back in canonical order. When an echo matches the head of the
 * fork the message is already on the canvas and must not be applied again.
 * When it doesn't match (e.g. the same user drawing over another connection),
 * the local canvas has diverged from the server's order: the caller rolls the
 * layers back to the savepoint and replays the server-confirmed messages. The
 * cleared fork entries are still in flight and re-arrive as ordinary echoes,
 * so all clients converge on the server's message order.
 */

import type { DecodedMessage } from "./binaryProtocol";

export interface LayerSavepoint {
  foreground: Uint8ClampedArray;
  background: Uint8ClampedArray;
}

export type ReconcileResult =
  | { action: "apply" }
  | { action: "already-done" }
  | { action: "rollback"; savepoint: LayerSavepoint; confirmed: DecodedMessage[] };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class LocalFork {
  private entries: Uint8Array[] = [];
  private savepoint: LayerSavepoint | null = null;
  private confirmed: DecodedMessage[] = [];

  get size(): number {
    return this.entries.length;
  }

  /**
   * Must be called synchronously BEFORE mutating the local layers for a
   * message that will be pushed. Captures the pre-mutation layer state as the
   * rollback savepoint when the fork is inactive.
   */
  beginLocalChange(captureSavepoint: () => LayerSavepoint): void {
    if (this.savepoint === null) {
      this.savepoint = captureSavepoint();
      this.confirmed = [];
    }
  }

  /**
   * Queues the exact bytes of a sent message so it can be matched against the
   * server's echo. Call in the same synchronous block as beginLocalChange.
   */
  push(message: ArrayBuffer): void {
    this.entries.push(new Uint8Array(message));
  }

  /**
   * Reconciles an incoming message from the local user against the fork.
   *
   * - "apply": the fork is inactive (e.g. history replay during catch-up);
   *   the caller should apply the message normally.
   * - "already-done": the echo matched the fork head; the message is already
   *   on the canvas and must be skipped.
   * - "rollback": the server's order diverged from the fork. The fork is
   *   cleared; the caller must restore the savepoint, replay the confirmed
   *   messages, then apply the incoming message. In-flight fork messages
   *   re-arrive as echoes and take the "apply" path.
   */
  reconcile(raw: Uint8Array, decoded: DecodedMessage): ReconcileResult {
    if (this.entries.length === 0) {
      return { action: "apply" };
    }

    if (bytesEqual(this.entries[0], raw)) {
      this.entries.shift();
      this.confirmed.push(decoded);
      if (this.entries.length === 0) {
        // Everything local is confirmed; the canvas matches the server state
        this.reset();
      }
      return { action: "already-done" };
    }

    const savepoint = this.savepoint;
    const confirmed = this.confirmed;
    this.reset();
    if (savepoint === null) {
      // Shouldn't happen (entries imply a savepoint), but fall back gracefully
      return { action: "apply" };
    }
    return { action: "rollback", savepoint, confirmed };
  }

  clear(): void {
    this.reset();
  }

  private reset(): void {
    this.entries = [];
    this.savepoint = null;
    this.confirmed = [];
  }
}
