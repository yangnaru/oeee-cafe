export const DEFAULT_PALETTE_COLORS = [
  "#ffffff",
  "#000000",
  "#888888",
  "#b47575",
  "#c096c0",
  "#fa9696",
  "#8080ff",
  "#ffb6ff",
  "#e7e58d",
  "#25c7c9",
  "#99cb7b",
  "#e7962d",
  "#f9ddcf",
  "#fcece2",
];

// Brush initialization function
export const initializeBrushes = (): { [key: number]: Uint8Array } => {
  const brush: { [key: number]: Uint8Array } = {};
  
  // init brush
  for (let r = 1; r <= 30; r++) {
    brush[r] = new Uint8Array(r * r);
    const mask = brush[r];
    let index = 0;
    for (let x = 0; x < r; x++) {
      for (let y = 0; y < r; y++) {
        const xx = x + 0.5 - r / 2.0;
        const yy = y + 0.5 - r / 2.0;
        mask[index++] = xx * xx + yy * yy <= (r * r) / 4 ? 1 : 0;
      }
    }
  }
  
  // Special brush modifications
  brush[3][0] = 0;
  brush[3][2] = 0;
  brush[3][6] = 0;
  brush[3][8] = 0;

  brush[5][1] = 0;
  brush[5][3] = 0;
  brush[5][5] = 0;
  brush[5][9] = 0;
  brush[5][15] = 0;
  brush[5][19] = 0;
  brush[5][21] = 0;
  brush[5][23] = 0;
  
  return brush;
};

// Tone initialization function
export const initializeTones = (): { [key: string]: Uint8Array } => {
  const tone: { [key: string]: Uint8Array } = {};
  
  // Initialize tone patterns similar to Neo.Painter
  const tonePattern = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const toneData: Uint8Array[] = [];

  for (let i = 0; i < 16; i++) {
    const arr = new Uint8Array(16);
    for (let j = 0; j < 16; j++) {
      arr[j] = i >= tonePattern[j] ? 1 : 0;
    }
    toneData.push(arr);
  }

  // Fill the tone object for compatibility
  for (let i = 0; i < 16; i++) {
    tone[i] = toneData[i];
  }
  
  return tone;
};