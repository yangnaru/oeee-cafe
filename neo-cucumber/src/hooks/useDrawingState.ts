import { useCallback, useState } from "react";
import { type DrawingState } from "../types/collaboration";
import type { ToolId } from "../neo/tools";
import {
  DEFAULT_PALETTE_COLORS,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  TWO_TONE_FOREGROUND_PEN_INDEX,
  TWO_TONE_INITIAL_PEN_SIZES,
} from "../constants/drawing";

export const useDrawingState = () => {
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(1); // Start with black selected
  const [paletteColors, setPaletteColors] = useState(DEFAULT_PALETTE_COLORS);
  // Per-pen size memory. Only two-tone mode populates this; elsewhere a single
  // brush size is shared across the palette and this stays null.
  const [penSizes, setPenSizes] = useState<number[] | null>(null);

  const [drawingState, setDrawingState] = useState<DrawingState>({
    brushSize: 1,
    opacity: 255,
    color: "#000000",
    brushType: "solid",
    layerType: "foreground",
    zoomLevel: 100,
    fgVisible: true,
    bgVisible: true,
    isFlippedHorizontal: false,
  });

  const updateBrushType = useCallback((type: ToolId) => {
    setDrawingState((prev) => {
      let newOpacity = prev.opacity;
      if (type === "halftone") newOpacity = 23;
      else if (["solid", "eraser", "fill", "pan"].includes(type))
        newOpacity = 255;

      return { ...prev, brushType: type, opacity: newOpacity };
    });
  }, []);

  const updateColor = useCallback(
    (newColor: string) => {
      setDrawingState((prev) => ({ ...prev, color: newColor }));

      window.dispatchEvent(
        new CustomEvent("colorChanged", { detail: { color: newColor } })
      );

      const matchingIndex = paletteColors.indexOf(newColor);
      if (matchingIndex !== -1) {
        setSelectedPaletteIndex(matchingIndex);
      }
    },
    [paletteColors]
  );

  // Handle color picker changes - updates palette if a palette slot is selected
  const handleColorPickerChange = useCallback(
    (newColor: string) => {
      // If a palette color is currently selected, update that palette slot
      if (
        selectedPaletteIndex >= 0 &&
        selectedPaletteIndex < paletteColors.length
      ) {
        const newPaletteColors = [...paletteColors];
        newPaletteColors[selectedPaletteIndex] = newColor;
        setPaletteColors(newPaletteColors);
      }

      // Update the current color
      updateColor(newColor);
    },
    [selectedPaletteIndex, paletteColors, updateColor]
  );

  // Set the active brush size, remembering it against the current pen so that
  // switching pens restores the size that pen was last used at.
  const setPenSize = useCallback(
    (size: number) => {
      const clamped = Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, size));
      setDrawingState((prev) => ({ ...prev, brushSize: clamped }));
      setPenSizes((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        next[selectedPaletteIndex] = clamped;
        return next;
      });
    },
    [selectedPaletteIndex]
  );

  // Step the size of the current pen, as Tegaki's [ and ] keys do
  const adjustPenSize = useCallback(
    (delta: number) => {
      setPenSize(drawingState.brushSize + delta);
    },
    [drawingState.brushSize, setPenSize]
  );

  // Select a pen by palette index, restoring both its color and its size.
  const selectPen = useCallback(
    (index: number) => {
      const color = paletteColors[index];
      if (color === undefined) return;

      setSelectedPaletteIndex(index);
      setDrawingState((prev) => ({
        ...prev,
        color,
        brushSize: penSizes?.[index] ?? prev.brushSize,
      }));

      window.dispatchEvent(
        new CustomEvent("colorChanged", { detail: { color } })
      );
    },
    [paletteColors, penSizes]
  );

  // Toggle between the two pens, as Tegaki's X key does
  const swapPen = useCallback(() => {
    selectPen(selectedPaletteIndex === 0 ? 1 : 0);
  }, [selectPen, selectedPaletteIndex]);

  // Initialize for two-tone drawing mode
  const initializeForTwoTone = useCallback(
    (backgroundColor: string, foregroundColor: string) => {
      setPaletteColors([backgroundColor, foregroundColor]);
      setSelectedPaletteIndex(TWO_TONE_FOREGROUND_PEN_INDEX);
      setPenSizes([...TWO_TONE_INITIAL_PEN_SIZES]);
      setDrawingState((prev) => ({
        ...prev,
        brushSize: TWO_TONE_INITIAL_PEN_SIZES[TWO_TONE_FOREGROUND_PEN_INDEX],
        color: foregroundColor,
        brushType: "solid",
        opacity: 255,
        layerType: "background",
      }));
    },
    []
  );

  return {
    // State
    drawingState,
    selectedPaletteIndex,
    paletteColors,
    penSizes,

    // Setters
    setDrawingState,
    setSelectedPaletteIndex,
    setPaletteColors,

    // Actions
    updateBrushType,
    updateColor,
    handleColorPickerChange,
    initializeForTwoTone,
    selectPen,
    swapPen,
    setPenSize,
    adjustPenSize,
  };
};