import { describe, expect, it } from "vitest";
import { acceptedResumeSequence } from "./synchronization";

const retained = { historyId: "history-a", sequence: 7 };

describe("reconnect history negotiation", () => {
  it("continues with the next missing canonical entry", () => {
    expect(acceptedResumeSequence(true, retained, "history-a", 8, "entry")).toBe(7);
  });

  it("accepts an empty incremental replay at the retained position", () => {
    expect(acceptedResumeSequence(true, retained, "history-a", 7, "caughtUp")).toBe(7);
  });

  it("falls back when history changed or the server replayed an old entry", () => {
    expect(acceptedResumeSequence(true, retained, "history-b", 8, "entry")).toBeNull();
    expect(acceptedResumeSequence(true, retained, "history-a", 1, "entry")).toBeNull();
  });

  it("never retains the canvas when no resume was requested", () => {
    expect(acceptedResumeSequence(false, retained, "history-a", 8, "entry")).toBeNull();
  });
});
