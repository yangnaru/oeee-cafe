import { compressToUint8Array } from "lz-string";

// Type for action items - can be strings, numbers, or nested arrays
type ActionItem = string | number | ActionItem[];

/**
 * ActionRecorder - Records drawing operations for replay
 * Mirrors Neo.ActionManager functionality
 */
export class ActionRecorder {
  private items: ActionItem[][] = [];
  private head: number = 0;

  /**
   * Create a new action frame (called on pointer down / stroke start)
   */
  step(): void {
    // Truncate items array if we're not at the end (redo history should be discarded)
    if (this.items.length > this.head) {
      this.items.length = this.head;
    }
    // Push empty array for new action
    this.items.push([]);
    this.head++;
  }

  /**
   * Add data to the current action frame
   */
  push(...args: ActionItem[]): void {
    if (this.head > 0 && this.head <= this.items.length) {
      const currentAction = this.items[this.head - 1];
      currentAction.push(...args);
    }
  }

  /**
   * Undo - move head back
   */
  back(): void {
    if (this.head > 0) {
      this.head--;
    }
  }

  /**
   * Redo - move head forward
   */
  forward(): void {
    if (this.head < this.items.length) {
      this.head++;
    }
  }

  /**
   * Add restore action at the end (final state of both layers)
   * This enables animation skip in Neo.Painter
   */
  addRestoreAction(bgDataURL: string, fgDataURL: string): void {
    // Check if last action is already a restore action
    const lastItem = this.items.length > 0 ? this.items[this.items.length - 1] : null;
    if (lastItem && lastItem[0] === "restore") {
      // Replace existing restore action
      this.items[this.items.length - 1] = ["restore", bgDataURL, fgDataURL];
    } else {
      // Add new restore action
      this.items.push(["restore", bgDataURL, fgDataURL]);
      this.head++;
    }
  }

  /**
   * Generate replay blob in PCH format
   */
  getReplayBlob(width: number, height: number): Blob {
    // Truncate items to current head position
    const itemsToExport = this.items.slice(0, this.head);

    // Serialize to JSON and compress
    const data = JSON.stringify(itemsToExport);
    const compressedData = compressToUint8Array(data);

    // PCH format:
    // - Magic: "NEO " (4 bytes)
    // - Width: 2 bytes (little-endian)
    // - Height: 2 bytes (little-endian)
    // - Reserved: 4 bytes (zeros)
    // - Compressed data
    const magic = "NEO ";
    const widthBytes = new Uint8Array([width % 0x100, Math.floor(width / 0x100)]);
    const heightBytes = new Uint8Array([height % 0x100, Math.floor(height / 0x100)]);
    const reserved = new Uint8Array(4);

    return new Blob([
      magic,
      widthBytes,
      heightBytes,
      reserved,
      new Uint8Array(compressedData),
    ]);
  }
}
