/**
 * Binary WebSocket protocol for efficient collaborative drawing
 *
 * Message Types:
 * - 0x00-0x0F: Server messages (parsed by server)
 * - 0x10+: Client messages (broadcast only)
 *
 * Canvas messages carry a 1-byte session-scoped user id (assigned by the
 * server via WELCOME, Drawpile's "context id") instead of a 16-byte UUID.
 * Identity/presence messages (join, chat, layers...) still use UUIDs.
 */

// Message type constants
export const MSG_TYPE = {
  // Server messages (< 0x10) - server parses and handles
  JOIN: 0x01,
  SNAPSHOT: 0x02,
  CHAT: 0x03,
  LAYERS: 0x06,
  END_SESSION: 0x07,
  SESSION_EXPIRED: 0x08,
  LEAVE: 0x09,
  // Wraps a history message with its canonical sequence number (server -> client)
  SEQUENCED: 0x0a,
  // Asks this client to upload a session reset (server -> client)
  RESET_REQUEST: 0x0b,
  // Announces a session reset upload: base seq + snapshot count (client -> server)
  RESET_BEGIN: 0x0c,
  // Notifies clients that history at or below a base seq was squashed (server -> client)
  RESET_POINT: 0x0d,
  // Tells a connecting client its 1-byte session user id (server -> client)
  WELCOME: 0x0e,

  // Client messages (>= 0x10) - server just broadcasts
  FILL: 0x12,
  POINTER_UP: 0x13,
  // Marks the start of an undoable operation (stroke or fill)
  UNDO_POINT: 0x14,
  // Undo (or redo) the sender's most recent operation
  UNDO: 0x15,
  // A batch of contiguous polyline points sharing one set of brush properties
  STROKE: 0x16,
} as const;

// Layer constants
export const LAYER = {
  FOREGROUND: 0,
  BACKGROUND: 1,
} as const;

// Brush type constants
export const BRUSH_TYPE = {
  SOLID: 0,
  HALFTONE: 1,
  ERASER: 2,
} as const;

// Pointer type constants
export const POINTER_TYPE = {
  MOUSE: 0,
  PEN: 1,
  TOUCH: 2,
} as const;

/**
 * Convert UUID string to 16-byte array
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert 16-byte array to UUID string
 */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Write little-endian uint16 to buffer
 */
function writeUint16LE(
  buffer: Uint8Array,
  offset: number,
  value: number
): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Write little-endian int16 to buffer
 */
function writeInt16LE(buffer: Uint8Array, offset: number, value: number): void {
  const uint16Value = value < 0 ? value + 65536 : value;
  buffer[offset] = uint16Value & 0xff;
  buffer[offset + 1] = (uint16Value >> 8) & 0xff;
}

/**
 * Write little-endian uint32 to buffer
 */
function writeUint32LE(
  buffer: Uint8Array,
  offset: number,
  value: number
): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Write little-endian uint64 to buffer
 */
function writeUint64LE(
  buffer: Uint8Array,
  offset: number,
  value: number
): void {
  writeUint32LE(buffer, offset, value & 0xffffffff);
  writeUint32LE(buffer, offset + 4, Math.floor(value / 0x100000000));
}

/**
 * Read little-endian uint16 from buffer
 */
function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

/**
 * Read little-endian int16 from buffer
 */
function readInt16LE(buffer: Uint8Array, offset: number): number {
  const uint16Value = buffer[offset] | (buffer[offset + 1] << 8);
  return uint16Value >= 32768 ? uint16Value - 65536 : uint16Value;
}

/**
 * Read little-endian uint32 from buffer
 */
function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset] |
    (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 3] << 24)
  );
}

/**
 * Read little-endian uint64 from buffer
 */
function readUint64LE(buffer: Uint8Array, offset: number): number {
  const low = readUint32LE(buffer, offset);
  const high = readUint32LE(buffer, offset + 4);
  return low + high * 0x100000000;
}

/**
 * Encode JOIN message (0x01)
 * Format: [0x01][UUID:16][timestamp:8]
 */
export function encodeJoin(userId: string, timestamp: number): ArrayBuffer {
  const buffer = new Uint8Array(25);
  buffer[0] = MSG_TYPE.JOIN;
  buffer.set(uuidToBytes(userId), 1);
  writeUint64LE(buffer, 17, timestamp);
  return buffer.buffer;
}

/**
 * Encode SNAPSHOT message (0x02)
 * Format: [0x02][id:1][layer:1][pngLength:4][pngData:variable]
 */
export async function encodeSnapshot(
  userId: number,
  layer: "foreground" | "background",
  pngBlob: Blob
): Promise<ArrayBuffer> {
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const buffer = new Uint8Array(7 + pngBytes.length);

  buffer[0] = MSG_TYPE.SNAPSHOT;
  buffer[1] = userId;
  buffer[2] = layer === "foreground" ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeUint32LE(buffer, 3, pngBytes.length);
  buffer.set(pngBytes, 7);

  return buffer.buffer;
}

/**
 * Encode STROKE message (0x16)
 * A batch of contiguous polyline points sharing one set of brush properties.
 * Each point continues the sender's stroke from their previous point (or
 * starts a dot after an UNDO_POINT reset).
 * Format: [0x16][id:1][layer:1][brushSize:1][brushType:1][r:1][g:1][b:1][a:1][count:2][(x:2,y:2)*count]
 */
export function encodeStroke(
  userId: number,
  layer: "foreground" | "background",
  brushSize: number,
  brushType: "solid" | "halftone" | "eraser",
  r: number,
  g: number,
  b: number,
  a: number,
  points: { x: number; y: number }[]
): ArrayBuffer {
  const buffer = new Uint8Array(11 + points.length * 4);

  buffer[0] = MSG_TYPE.STROKE;
  buffer[1] = userId;
  buffer[2] = layer === "foreground" ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  buffer[3] = brushSize;
  buffer[4] =
    brushType === "solid"
      ? BRUSH_TYPE.SOLID
      : brushType === "halftone"
      ? BRUSH_TYPE.HALFTONE
      : BRUSH_TYPE.ERASER;
  buffer[5] = r;
  buffer[6] = g;
  buffer[7] = b;
  buffer[8] = a;
  writeUint16LE(buffer, 9, points.length);
  for (let i = 0; i < points.length; i++) {
    writeInt16LE(buffer, 11 + i * 4, Math.round(points[i].x));
    writeInt16LE(buffer, 13 + i * 4, Math.round(points[i].y));
  }

  return buffer.buffer;
}

/**
 * Encode FILL message (0x12)
 * Format: [0x12][id:1][layer:1][x:2][y:2][r:1][g:1][b:1][a:1]
 */
export function encodeFill(
  userId: number,
  layer: "foreground" | "background",
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number
): ArrayBuffer {
  const buffer = new Uint8Array(11);

  buffer[0] = MSG_TYPE.FILL;
  buffer[1] = userId;
  buffer[2] = layer === "foreground" ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeInt16LE(buffer, 3, Math.round(x));
  writeInt16LE(buffer, 5, Math.round(y));
  buffer[7] = r;
  buffer[8] = g;
  buffer[9] = b;
  buffer[10] = a;

  return buffer.buffer;
}

/**
 * Encode CHAT message (0x03)
 * Format: [0x03][UUID:16][timestamp:8][msgLength:2][msgData:variable(UTF-8)]
 */
export function encodeChat(
  userId: string,
  message: string,
  timestamp: number
): ArrayBuffer {
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(message);
  const buffer = new Uint8Array(27 + msgBytes.length);

  buffer[0] = MSG_TYPE.CHAT;
  buffer.set(uuidToBytes(userId), 1);
  writeUint64LE(buffer, 17, timestamp);
  writeUint16LE(buffer, 25, msgBytes.length);
  buffer.set(msgBytes, 27);

  return buffer.buffer;
}


/**
 * Encode RESET_BEGIN message (0x0C)
 * Announces a session reset upload: the following `count` snapshot messages
 * represent the full canvas state at canonical history position `lastSeq`.
 * Format: [0x0C][lastSeq:8][count:2]
 */
export function encodeResetBegin(lastSeq: number, count: number): ArrayBuffer {
  const buffer = new Uint8Array(11);
  buffer[0] = MSG_TYPE.RESET_BEGIN;
  writeUint64LE(buffer, 1, lastSeq);
  writeUint16LE(buffer, 9, count);
  return buffer.buffer;
}

/**
 * Encode UNDO_POINT message (0x14)
 * Format: [0x14][id:1]
 */
export function encodeUndoPoint(userId: number): ArrayBuffer {
  const buffer = new Uint8Array(2);
  buffer[0] = MSG_TYPE.UNDO_POINT;
  buffer[1] = userId;
  return buffer.buffer;
}

/**
 * Encode UNDO message (0x15)
 * Format: [0x15][id:1][redo:1]
 */
export function encodeUndo(userId: number, redo: boolean): ArrayBuffer {
  const buffer = new Uint8Array(3);
  buffer[0] = MSG_TYPE.UNDO;
  buffer[1] = userId;
  buffer[2] = redo ? 1 : 0;
  return buffer.buffer;
}

/**
 * Unwrap a SEQUENCED envelope (0x0A): [0x0A][seq:8][payload]
 * Returns null if the buffer is not a sequenced envelope.
 */
export function unwrapSequenced(
  data: ArrayBuffer
): { seq: number; payload: ArrayBuffer } | null {
  const buffer = new Uint8Array(data);
  if (buffer.length < 10 || buffer[0] !== MSG_TYPE.SEQUENCED) {
    return null;
  }
  return {
    seq: readUint64LE(buffer, 1),
    payload: data.slice(9),
  };
}

/**
 * Encode END_SESSION message (0x07)
 * Format: [0x07][UUID:16][postUrlLength:2][postUrl:variable(UTF-8)]
 */
export function encodeEndSession(userId: string, postUrl: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const urlBytes = encoder.encode(postUrl);
  const buffer = new Uint8Array(19 + urlBytes.length);

  buffer[0] = MSG_TYPE.END_SESSION;
  buffer.set(uuidToBytes(userId), 1);
  writeUint16LE(buffer, 17, urlBytes.length);
  buffer.set(urlBytes, 19);

  return buffer.buffer;
}

/**
 * Encode POINTER_UP message (0x13)
 * Format: [0x13][id:1]
 */
export function encodePointerUp(userId: number): ArrayBuffer {
  const buffer = new Uint8Array(2);
  buffer[0] = MSG_TYPE.POINTER_UP;
  buffer[1] = userId;
  return buffer.buffer;
}

// Decoded message types
export interface JoinMessage {
  type: "join";
  userId: string;
  username: string;
  timestamp: number;
}

export interface LayersMessage {
  type: "layers";
  participants: Array<{
    userId: string;
    sessionId: number;
    username: string;
    joinTimestamp: number;
  }>;
}

export interface WelcomeMessage {
  type: "welcome";
  sessionId: number;
}

export interface SnapshotMessage {
  type: "snapshot";
  userId: number;
  layer: "foreground" | "background";
  pngData: Uint8Array;
}

export interface StrokeMessage {
  type: "stroke";
  userId: number;
  layer: "foreground" | "background";
  brushSize: number;
  brushType: "solid" | "halftone" | "eraser";
  color: { r: number; g: number; b: number; a: number };
  points: { x: number; y: number }[];
}

export interface FillMessage {
  type: "fill";
  userId: number;
  layer: "foreground" | "background";
  x: number;
  y: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface ChatMessage {
  type: "chat";
  userId: string;
  username: string;
  timestamp: number;
  message: string;
}

export interface ResetRequestMessage {
  type: "resetRequest";
  timestamp: number;
}

export interface ResetPointMessage {
  type: "resetPoint";
  baseSeq: number;
}

export interface UndoPointMessage {
  type: "undoPoint";
  userId: number;
}

export interface UndoMessage {
  type: "undo";
  userId: number;
  redo: boolean;
}

export interface PointerUpMessage {
  type: "pointerup";
  userId: number;
}

export interface EndSessionMessage {
  type: "endSession";
  userId: string;
  postUrl: string;
}

export interface SessionExpiredMessage {
  type: "sessionExpired";
  sessionId: string;
}

export interface LeaveMessage {
  type: "leave";
  userId: string;
  username: string;
  timestamp: number;
}

export type DecodedMessage =
  | JoinMessage
  | LayersMessage
  | WelcomeMessage
  | SnapshotMessage
  | ChatMessage
  | ResetRequestMessage
  | ResetPointMessage
  | UndoPointMessage
  | UndoMessage
  | StrokeMessage
  | FillMessage
  | PointerUpMessage
  | EndSessionMessage
  | SessionExpiredMessage
  | LeaveMessage;

/**
 * Decode SNAPSHOT message specifically
 * This is a convenience function that wraps decodeMessage for snapshot handling
 */
export function decodeSnapshot(data: ArrayBuffer): SnapshotMessage | null {
  const message = decodeMessage(data);
  if (message && message.type === "snapshot") {
    return message as SnapshotMessage;
  }
  return null;
}

/**
 * Decode binary message based on message type
 */
export function decodeMessage(data: ArrayBuffer): DecodedMessage | null {
  const buffer = new Uint8Array(data);
  if (buffer.length === 0) return null;

  const msgType = buffer[0];

  switch (msgType) {
    case MSG_TYPE.JOIN: {
      // Format: [0x01][UUID:16][timestamp:8][usernameLength:2][username:variable]
      if (buffer.length < 27) return null; // Minimum: 1 + 16 + 8 + 2 + 0

      const joinUsernameLength = readUint16LE(buffer, 25);
      if (buffer.length < 27 + joinUsernameLength) return null;

      const joinDecoder = new TextDecoder();
      return {
        type: "join",
        userId: bytesToUuid(buffer.slice(1, 17)),
        timestamp: readUint64LE(buffer, 17),
        username: joinDecoder.decode(buffer.slice(27, 27 + joinUsernameLength)),
      };
    }

    case MSG_TYPE.LAYERS: {
      if (buffer.length < 3) return null;
      const participantCount = readUint16LE(buffer, 1);

      const participants: Array<{
        userId: string;
        sessionId: number;
        username: string;
        joinTimestamp: number;
      }> = [];
      let offset = 3;

      for (let i = 0; i < participantCount; i++) {
        // uuid (16) + session id (1) + name length (2) + timestamp (8)
        if (offset + 27 > buffer.length) return null;

        const userId = bytesToUuid(buffer.slice(offset, offset + 16));
        offset += 16;

        const sessionId = buffer[offset];
        offset += 1;

        const nameLength = readUint16LE(buffer, offset);
        offset += 2;

        if (offset + nameLength + 8 > buffer.length) return null;

        const username = new TextDecoder().decode(buffer.slice(offset, offset + nameLength));
        offset += nameLength;

        const joinTimestamp = readUint64LE(buffer, offset);
        offset += 8;

        participants.push({ userId, sessionId, username, joinTimestamp });
      }

      return {
        type: "layers",
        participants: participants,
      };
    }

    case MSG_TYPE.WELCOME:
      if (buffer.length < 2) return null;
      return {
        type: "welcome",
        sessionId: buffer[1],
      };

    case MSG_TYPE.CHAT: {
      // Format: [0x03][UUID:16][timestamp:8][usernameLength:2][username:variable][msgLength:2][msgData:variable]
      if (buffer.length < 29) return null; // Minimum: 1 + 16 + 8 + 2 + 0 + 2 + 0

      const usernameLength = readUint16LE(buffer, 25);
      if (buffer.length < 29 + usernameLength) return null;

      const msgLength = readUint16LE(buffer, 27 + usernameLength);
      if (buffer.length < 29 + usernameLength + msgLength) return null;

      const decoder = new TextDecoder();
      return {
        type: "chat",
        userId: bytesToUuid(buffer.slice(1, 17)),
        timestamp: readUint64LE(buffer, 17),
        username: decoder.decode(buffer.slice(27, 27 + usernameLength)),
        message: decoder.decode(
          buffer.slice(29 + usernameLength, 29 + usernameLength + msgLength)
        ),
      };
    }

    case MSG_TYPE.RESET_REQUEST:
      if (buffer.length < 9) return null;
      return {
        type: "resetRequest",
        timestamp: readUint64LE(buffer, 1),
      };

    case MSG_TYPE.RESET_POINT:
      if (buffer.length < 9) return null;
      return {
        type: "resetPoint",
        baseSeq: readUint64LE(buffer, 1),
      };

    case MSG_TYPE.UNDO_POINT:
      if (buffer.length < 2) return null;
      return {
        type: "undoPoint",
        userId: buffer[1],
      };

    case MSG_TYPE.UNDO:
      if (buffer.length < 3) return null;
      return {
        type: "undo",
        userId: buffer[1],
        redo: buffer[2] !== 0,
      };

    case MSG_TYPE.SNAPSHOT: {
      if (buffer.length < 7) return null;
      const pngLength = readUint32LE(buffer, 3);
      if (buffer.length < 7 + pngLength) return null;
      return {
        type: "snapshot",
        userId: buffer[1],
        layer: buffer[2] === LAYER.FOREGROUND ? "foreground" : "background",
        pngData: buffer.slice(7, 7 + pngLength),
      };
    }

    case MSG_TYPE.STROKE: {
      if (buffer.length < 11) return null;
      const count = readUint16LE(buffer, 9);
      if (buffer.length < 11 + count * 4) return null;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < count; i++) {
        points.push({
          x: readInt16LE(buffer, 11 + i * 4),
          y: readInt16LE(buffer, 13 + i * 4),
        });
      }
      return {
        type: "stroke",
        userId: buffer[1],
        layer: buffer[2] === LAYER.FOREGROUND ? "foreground" : "background",
        brushSize: buffer[3],
        brushType:
          buffer[4] === BRUSH_TYPE.SOLID
            ? "solid"
            : buffer[4] === BRUSH_TYPE.HALFTONE
            ? "halftone"
            : "eraser",
        color: { r: buffer[5], g: buffer[6], b: buffer[7], a: buffer[8] },
        points,
      };
    }

    case MSG_TYPE.FILL:
      if (buffer.length < 11) return null;
      return {
        type: "fill",
        userId: buffer[1],
        layer: buffer[2] === LAYER.FOREGROUND ? "foreground" : "background",
        x: readInt16LE(buffer, 3),
        y: readInt16LE(buffer, 5),
        color: { r: buffer[7], g: buffer[8], b: buffer[9], a: buffer[10] },
      };

    case MSG_TYPE.POINTER_UP:
      if (buffer.length < 2) return null;
      return {
        type: "pointerup",
        userId: buffer[1],
      };

    case MSG_TYPE.END_SESSION: {
      if (buffer.length < 19) return null;
      const urlLength = readUint16LE(buffer, 17);
      if (buffer.length < 19 + urlLength) return null;
      const decoder = new TextDecoder();
      return {
        type: "endSession",
        userId: bytesToUuid(buffer.slice(1, 17)),
        postUrl: decoder.decode(buffer.slice(19, 19 + urlLength)),
      };
    }

    case MSG_TYPE.SESSION_EXPIRED:
      if (buffer.length < 17) return null;
      return {
        type: "sessionExpired",
        sessionId: bytesToUuid(buffer.slice(1, 17)),
      };

    case MSG_TYPE.LEAVE: {
      // Format: [0x09][UUID:16][timestamp:8][usernameLength:2][username:variable]
      if (buffer.length < 27) return null; // Minimum: 1 + 16 + 8 + 2 + 0

      const leaveUsernameLength = readUint16LE(buffer, 25);
      if (buffer.length < 27 + leaveUsernameLength) return null;

      const leaveDecoder = new TextDecoder();
      return {
        type: "leave",
        userId: bytesToUuid(buffer.slice(1, 17)),
        timestamp: readUint64LE(buffer, 17),
        username: leaveDecoder.decode(
          buffer.slice(27, 27 + leaveUsernameLength)
        ),
      };
    }

    default:
      return null;
  }
}
