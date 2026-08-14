export interface CanonicalPosition {
  historyId: string | null;
  sequence: number;
}

/**
 * Decide whether a reconnect response continues the canvas we retained.
 * A replay entry must begin after our position; an empty incremental replay
 * is represented by CAUGHT_UP at the same position. Everything else is a
 * server-directed full replay and must replace the retained canvas.
 */
export function acceptedResumeSequence(
  requested: boolean,
  retained: CanonicalPosition,
  incomingHistoryId: string,
  incomingSequence: number,
  boundary: "entry" | "caughtUp",
): number | null {
  if (!requested || retained.historyId !== incomingHistoryId) return null;
  const sequenceIsValid = boundary === "entry"
    ? incomingSequence > retained.sequence
    : incomingSequence >= retained.sequence;
  return sequenceIsValid ? retained.sequence : null;
}
