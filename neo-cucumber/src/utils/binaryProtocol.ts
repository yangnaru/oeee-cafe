/**
 * Binary WebSocket protocol for efficient collaborative drawing
 * 
 * Message Types:
 * - 0x00-0x0F: Server messages (parsed by server)
 * - 0x10+: Client messages (broadcast only)
 */

// Message type constants
export const MSG_TYPE = {
  // Server messages (< 0x10) - server parses and handles
  JOIN: 0x01,
  SNAPSHOT: 0x02,
  CHAT: 0x03,
  
  // Client messages (>= 0x10) - server just broadcasts
  DRAW_LINE: 0x10,
  DRAW_POINT: 0x11,
  FILL: 0x12,
  POINTER_UP: 0x13,
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
  const hex = uuid.replace(/-/g, '');
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
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

/**
 * Write little-endian uint16 to buffer
 */
function writeUint16LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Write little-endian uint32 to buffer
 */
function writeUint32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Write little-endian uint64 to buffer
 */
function writeUint64LE(buffer: Uint8Array, offset: number, value: number): void {
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
 * Read little-endian uint32 from buffer
 */
function readUint32LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | 
         (buffer[offset + 1] << 8) | 
         (buffer[offset + 2] << 16) | 
         (buffer[offset + 3] << 24);
}

/**
 * Read little-endian uint64 from buffer
 */
function readUint64LE(buffer: Uint8Array, offset: number): number {
  const low = readUint32LE(buffer, offset);
  const high = readUint32LE(buffer, offset + 4);
  return low + (high * 0x100000000);
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
 * Format: [0x02][UUID:16][layer:1][pngLength:4][pngData:variable]
 */
export async function encodeSnapshot(
  userId: string, 
  layer: 'foreground' | 'background', 
  pngBlob: Blob
): Promise<ArrayBuffer> {
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const buffer = new Uint8Array(22 + pngBytes.length);
  
  buffer[0] = MSG_TYPE.SNAPSHOT;
  buffer.set(uuidToBytes(userId), 1);
  buffer[17] = layer === 'foreground' ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeUint32LE(buffer, 18, pngBytes.length);
  buffer.set(pngBytes, 22);
  
  return buffer.buffer;
}

/**
 * Encode DRAW_LINE message (0x10)
 * Format: [0x10][UUID:16][layer:1][fromX:2][fromY:2][toX:2][toY:2][brushSize:1][brushType:1][r:1][g:1][b:1][a:1][pointerType:1]
 */
export function encodeDrawLine(
  userId: string,
  layer: 'foreground' | 'background',
  fromX: number, fromY: number,
  toX: number, toY: number,
  brushSize: number,
  brushType: 'solid' | 'halftone' | 'eraser',
  r: number, g: number, b: number, a: number,
  pointerType: 'mouse' | 'pen' | 'touch'
): ArrayBuffer {
  const buffer = new Uint8Array(39);
  
  buffer[0] = MSG_TYPE.DRAW_LINE;
  buffer.set(uuidToBytes(userId), 1);
  buffer[17] = layer === 'foreground' ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeUint16LE(buffer, 18, Math.round(fromX));
  writeUint16LE(buffer, 20, Math.round(fromY));
  writeUint16LE(buffer, 22, Math.round(toX));
  writeUint16LE(buffer, 24, Math.round(toY));
  buffer[26] = brushSize;
  buffer[27] = brushType === 'solid' ? BRUSH_TYPE.SOLID : 
               brushType === 'halftone' ? BRUSH_TYPE.HALFTONE : BRUSH_TYPE.ERASER;
  buffer[28] = r;
  buffer[29] = g;
  buffer[30] = b;
  buffer[31] = a;
  buffer[32] = pointerType === 'mouse' ? POINTER_TYPE.MOUSE :
               pointerType === 'pen' ? POINTER_TYPE.PEN : POINTER_TYPE.TOUCH;
  
  return buffer.buffer;
}

/**
 * Encode DRAW_POINT message (0x11)
 * Format: [0x11][UUID:16][layer:1][x:2][y:2][brushSize:1][brushType:1][r:1][g:1][b:1][a:1][pointerType:1]
 */
export function encodeDrawPoint(
  userId: string,
  layer: 'foreground' | 'background',
  x: number, y: number,
  brushSize: number,
  brushType: 'solid' | 'halftone' | 'eraser',
  r: number, g: number, b: number, a: number,
  pointerType: 'mouse' | 'pen' | 'touch'
): ArrayBuffer {
  const buffer = new Uint8Array(31);
  
  buffer[0] = MSG_TYPE.DRAW_POINT;
  buffer.set(uuidToBytes(userId), 1);
  buffer[17] = layer === 'foreground' ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeUint16LE(buffer, 18, Math.round(x));
  writeUint16LE(buffer, 20, Math.round(y));
  buffer[22] = brushSize;
  buffer[23] = brushType === 'solid' ? BRUSH_TYPE.SOLID : 
               brushType === 'halftone' ? BRUSH_TYPE.HALFTONE : BRUSH_TYPE.ERASER;
  buffer[24] = r;
  buffer[25] = g;
  buffer[26] = b;
  buffer[27] = a;
  buffer[28] = pointerType === 'mouse' ? POINTER_TYPE.MOUSE :
               pointerType === 'pen' ? POINTER_TYPE.PEN : POINTER_TYPE.TOUCH;
  
  return buffer.buffer;
}

/**
 * Encode FILL message (0x12)
 * Format: [0x12][UUID:16][layer:1][x:2][y:2][r:1][g:1][b:1][a:1]
 */
export function encodeFill(
  userId: string,
  layer: 'foreground' | 'background',
  x: number, y: number,
  r: number, g: number, b: number, a: number
): ArrayBuffer {
  const buffer = new Uint8Array(26);
  
  buffer[0] = MSG_TYPE.FILL;
  buffer.set(uuidToBytes(userId), 1);
  buffer[17] = layer === 'foreground' ? LAYER.FOREGROUND : LAYER.BACKGROUND;
  writeUint16LE(buffer, 18, Math.round(x));
  writeUint16LE(buffer, 20, Math.round(y));
  buffer[22] = r;
  buffer[23] = g;
  buffer[24] = b;
  buffer[25] = a;
  
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
 * Encode POINTER_UP message (0x13)
 * Format: [0x13][UUID:16][x:2][y:2][button:1][pointerType:1]
 */
export function encodePointerUp(
  userId: string,
  x: number, y: number,
  button: number,
  pointerType: 'mouse' | 'pen' | 'touch'
): ArrayBuffer {
  const buffer = new Uint8Array(23);
  
  buffer[0] = MSG_TYPE.POINTER_UP;
  buffer.set(uuidToBytes(userId), 1);
  writeUint16LE(buffer, 17, Math.round(x));
  writeUint16LE(buffer, 19, Math.round(y));
  buffer[21] = button;
  buffer[22] = pointerType === 'mouse' ? POINTER_TYPE.MOUSE :
               pointerType === 'pen' ? POINTER_TYPE.PEN : POINTER_TYPE.TOUCH;
  
  return buffer.buffer;
}

// Decoded message types
export interface JoinMessage {
  type: 'join';
  userId: string;
  timestamp: number;
}

export interface SnapshotMessage {
  type: 'snapshot';
  userId: string;
  layer: 'foreground' | 'background';
  pngData: Uint8Array;
}

export interface DrawLineMessage {
  type: 'drawLine';
  userId: string;
  layer: 'foreground' | 'background';
  fromX: number; fromY: number;
  toX: number; toY: number;
  brushSize: number;
  brushType: 'solid' | 'halftone' | 'eraser';
  color: { r: number; g: number; b: number; a: number };
  pointerType: 'mouse' | 'pen' | 'touch';
}

export interface DrawPointMessage {
  type: 'drawPoint';
  userId: string;
  layer: 'foreground' | 'background';
  x: number; y: number;
  brushSize: number;
  brushType: 'solid' | 'halftone' | 'eraser';
  color: { r: number; g: number; b: number; a: number };
  pointerType: 'mouse' | 'pen' | 'touch';
}

export interface FillMessage {
  type: 'fill';
  userId: string;
  layer: 'foreground' | 'background';
  x: number; y: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface ChatMessage {
  type: 'chat';
  userId: string;
  timestamp: number;
  message: string;
}

export interface PointerUpMessage {
  type: 'pointerup';
  userId: string;
  x: number; y: number;
  button: number;
  pointerType: 'mouse' | 'pen' | 'touch';
}

export type DecodedMessage = 
  | JoinMessage 
  | SnapshotMessage 
  | ChatMessage
  | DrawLineMessage 
  | DrawPointMessage 
  | FillMessage 
  | PointerUpMessage;

/**
 * Decode binary message based on message type
 */
export function decodeMessage(data: ArrayBuffer): DecodedMessage | null {
  const buffer = new Uint8Array(data);
  if (buffer.length === 0) return null;
  
  const msgType = buffer[0];
  
  switch (msgType) {
    case MSG_TYPE.JOIN:
      if (buffer.length < 25) return null;
      return {
        type: 'join',
        userId: bytesToUuid(buffer.slice(1, 17)),
        timestamp: readUint64LE(buffer, 17)
      };
      
    case MSG_TYPE.CHAT:
      if (buffer.length < 27) return null;
      const msgLength = readUint16LE(buffer, 25);
      if (buffer.length < 27 + msgLength) return null;
      const decoder = new TextDecoder();
      return {
        type: 'chat',
        userId: bytesToUuid(buffer.slice(1, 17)),
        timestamp: readUint64LE(buffer, 17),
        message: decoder.decode(buffer.slice(27, 27 + msgLength))
      };
      
    case MSG_TYPE.SNAPSHOT:
      if (buffer.length < 22) return null;
      const pngLength = readUint32LE(buffer, 18);
      if (buffer.length < 22 + pngLength) return null;
      return {
        type: 'snapshot',
        userId: bytesToUuid(buffer.slice(1, 17)),
        layer: buffer[17] === LAYER.FOREGROUND ? 'foreground' : 'background',
        pngData: buffer.slice(22, 22 + pngLength)
      };
      
    case MSG_TYPE.DRAW_LINE:
      if (buffer.length < 39) return null;
      return {
        type: 'drawLine',
        userId: bytesToUuid(buffer.slice(1, 17)),
        layer: buffer[17] === LAYER.FOREGROUND ? 'foreground' : 'background',
        fromX: readUint16LE(buffer, 18),
        fromY: readUint16LE(buffer, 20),
        toX: readUint16LE(buffer, 22),
        toY: readUint16LE(buffer, 24),
        brushSize: buffer[26],
        brushType: buffer[27] === BRUSH_TYPE.SOLID ? 'solid' :
                   buffer[27] === BRUSH_TYPE.HALFTONE ? 'halftone' : 'eraser',
        color: { r: buffer[28], g: buffer[29], b: buffer[30], a: buffer[31] },
        pointerType: buffer[32] === POINTER_TYPE.MOUSE ? 'mouse' :
                     buffer[32] === POINTER_TYPE.PEN ? 'pen' : 'touch'
      };
      
    case MSG_TYPE.DRAW_POINT:
      if (buffer.length < 31) return null;
      return {
        type: 'drawPoint',
        userId: bytesToUuid(buffer.slice(1, 17)),
        layer: buffer[17] === LAYER.FOREGROUND ? 'foreground' : 'background',
        x: readUint16LE(buffer, 18),
        y: readUint16LE(buffer, 20),
        brushSize: buffer[22],
        brushType: buffer[23] === BRUSH_TYPE.SOLID ? 'solid' :
                   buffer[23] === BRUSH_TYPE.HALFTONE ? 'halftone' : 'eraser',
        color: { r: buffer[24], g: buffer[25], b: buffer[26], a: buffer[27] },
        pointerType: buffer[28] === POINTER_TYPE.MOUSE ? 'mouse' :
                     buffer[28] === POINTER_TYPE.PEN ? 'pen' : 'touch'
      };
      
    case MSG_TYPE.FILL:
      if (buffer.length < 26) return null;
      return {
        type: 'fill',
        userId: bytesToUuid(buffer.slice(1, 17)),
        layer: buffer[17] === LAYER.FOREGROUND ? 'foreground' : 'background',
        x: readUint16LE(buffer, 18),
        y: readUint16LE(buffer, 20),
        color: { r: buffer[22], g: buffer[23], b: buffer[24], a: buffer[25] }
      };
      
    case MSG_TYPE.POINTER_UP:
      if (buffer.length < 23) return null;
      return {
        type: 'pointerup',
        userId: bytesToUuid(buffer.slice(1, 17)),
        x: readUint16LE(buffer, 17),
        y: readUint16LE(buffer, 19),
        button: buffer[21],
        pointerType: buffer[22] === POINTER_TYPE.MOUSE ? 'mouse' :
                     buffer[22] === POINTER_TYPE.PEN ? 'pen' : 'touch'
      };
      
    default:
      return null;
  }
}