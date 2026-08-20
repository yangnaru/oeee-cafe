/**
 * What this client thought was happening, sent when something says it was
 * wrong.
 *
 * The canonical stream is recorded on the server (`collaborate::archive`), and
 * for a whole class of failures that is enough. It was not enough for the one
 * that prompted all of this: the server's log of session c9b8321d was correct
 * from end to end, and the drawing still vanished, because a client applied a
 * correct stream incorrectly and then reported itself caught up. Nothing the
 * server could see distinguished it from a client that was fine.
 *
 * So this is the other half: the position this client believed it was at, and
 * the reconciliation decisions that got it there. Neither is recoverable after
 * the fact from anything -- the trace is a ring in memory, and the position is
 * a ref in a closure that goes with the tab.
 *
 * Sent on trouble rather than on a timer. A healthy session produces nothing;
 * the moments worth having are exactly the ones a client can already name.
 */

import type { PainterHandle } from "neo-cucumber";

/** What a report says, beyond the trace. */
export type DiagnosticContext = {
  /** Why this was sent, so a pile of them can be read without opening each. */
  reason: string;
  /** The session id the server assigned this connection, if it got that far. */
  localId: number | null;
  /** The position this client believed it had applied, and the one it wanted
   * next. A gap between these and `lastSeq` is the shape the checkpoint bug
   * took, and it is what nothing outside the tab could see. */
  appliedSequence: number;
  expectedSequence: number;
  lastSeq: number;
  catchingUp: boolean;
  /** False when an optimistic operation or a pointer gesture is outstanding. */
  settled: boolean;
  detail?: string;
};

/**
 * The trace is bounded at 512 events by the painter; this bounds what one
 * report can weigh anyway, since a report that is refused for size tells
 * nobody anything.
 */
const MAX_TRACE_EVENTS = 512;

/**
 * Sends one report. Never throws and never waits on the result: this runs on
 * paths that are already going wrong, and a client that fails to file a report
 * has more pressing problems than the report.
 */
export function reportDiagnostics(
  sessionId: string,
  painter: PainterHandle | null,
  context: DiagnosticContext,
): void {
  let trace: unknown[] = [];
  try {
    trace = (painter?.synchronizationTrace() ?? []).slice(-MAX_TRACE_EVENTS);
  } catch {
    // A painter mid-unmount has no trace to give. The context alone is still
    // worth having -- it carries the positions.
  }

  const body = JSON.stringify({
    format: "oeee-collab-diagnostic",
    version: 1,
    at: new Date().toISOString(),
    ...context,
    trace,
  });

  void fetch(`/collaborate/${sessionId}/diagnostics`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body,
    // The most valuable report is the one from a tab that is closing, and a
    // normal fetch is cancelled when it does.
    keepalive: true,
  }).catch(() => {
    // Reporting is best effort by construction.
  });
}
