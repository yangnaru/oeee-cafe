
type BrushType = "solid" | "halftone" | "eraser" | "fill" | "pan";
type LayerType = "foreground" | "background";

interface DrawingState {
  brushSize: number;
  opacity: number;
  color: string;
  brushType: BrushType;
  layerType: LayerType;
  zoomLevel: number;
  fgVisible: boolean;
  bgVisible: boolean;
  pendingPanDeltaX?: number;
  pendingPanDeltaY?: number;
}

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface ControlsProps {
  drawingState: DrawingState;
  setDrawingState: React.Dispatch<React.SetStateAction<DrawingState>>;
  historyState: HistoryState;
  paletteColors: string[];
  selectedPaletteIndex: number;
  setSelectedPaletteIndex: React.Dispatch<React.SetStateAction<number>>;
  currentZoom: number;
  fgThumbnailRef: React.RefObject<HTMLCanvasElement | null>;
  bgThumbnailRef: React.RefObject<HTMLCanvasElement | null>;
  isSessionOwner: boolean;
  isSaving: boolean;
  sessionEnded: boolean;
  joinResponseReceived: boolean;
  undo: () => void;
  redo: () => void;
  updateBrushType: (type: BrushType) => void;
  updateColor: (color: string) => void;
  handleColorPickerChange: (color: string) => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleZoomReset: () => void;
  saveCollaborativeDrawing: () => Promise<void>;
}

export function Controls({
  drawingState,
  setDrawingState,
  historyState,
  paletteColors,
  selectedPaletteIndex,
  setSelectedPaletteIndex,
  currentZoom,
  fgThumbnailRef,
  bgThumbnailRef,
  isSessionOwner,
  isSaving,
  sessionEnded,
  joinResponseReceived,
  undo,
  redo,
  updateBrushType,
  updateColor,
  handleColorPickerChange,
  handleZoomIn,
  handleZoomOut,
  handleZoomReset,
  saveCollaborativeDrawing,
}: ControlsProps) {
  return (
    <div id="controls">
      <div id="history-controls">
        <button
          id="undo-btn"
          type="button"
          onClick={undo}
          disabled={!historyState.canUndo}
        >
          Undo
        </button>
        <button
          id="redo-btn"
          type="button"
          onClick={redo}
          disabled={!historyState.canRedo}
        >
          Redo
        </button>
      </div>
      <div id="brush-type-controls">
        {(
          ["solid", "halftone", "eraser", "fill", "pan"] as BrushType[]
        ).map((type) => (
          <label key={type}>
            <input
              type="radio"
              name="brushType"
              value={type}
              checked={drawingState.brushType === type}
              onChange={() => updateBrushType(type)}
            />
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </label>
        ))}
      </div>
      <div id="color-picker-container">
        <div id="color-palette">
          {paletteColors.map((paletteColor, index) => (
            <button
              key={index}
              className={`color-btn ${
                selectedPaletteIndex === index ? "selected" : ""
              }`}
              style={{ backgroundColor: paletteColor }}
              onClick={() => {
                setSelectedPaletteIndex(index);
                updateColor(paletteColor);
              }}
              title={`Palette color ${index + 1}${
                selectedPaletteIndex === index
                  ? " (selected - edit with color picker below)"
                  : ""
              }`}
              data-color={paletteColor}
            />
          ))}
        </div>
        <input
          id="color-picker"
          type="color"
          value={drawingState.color}
          onChange={(e) => handleColorPickerChange(e.target.value)}
          aria-label="Custom color picker - edits selected palette color"
          title={
            selectedPaletteIndex >= 0
              ? `Edit palette color ${selectedPaletteIndex + 1}`
              : "Custom color picker"
          }
        />
      </div>

      <div id="size-controls">
        <label>
          Size
          <input
            id="brush-size-slider"
            type="range"
            min="1"
            max="30"
            value={drawingState.brushSize}
            onChange={(e) =>
              setDrawingState((prev) => ({
                ...prev,
                brushSize: parseInt(e.target.value),
              }))
            }
          />
        </label>
      </div>

      <div id="opacity-controls">
        <label>
          Opacity
          <input
            id="opacity-slider"
            type="range"
            min="1"
            max="255"
            value={drawingState.opacity}
            onChange={(e) =>
              setDrawingState((prev) => ({
                ...prev,
                opacity: parseInt(e.target.value),
              }))
            }
          />
        </label>
      </div>

      <div id="layer-controls">
        {(["foreground", "background"] as LayerType[]).map((layer) => (
          <label key={layer}>
            <input
              type="radio"
              name="layerType"
              value={layer}
              checked={drawingState.layerType === layer}
              onChange={() =>
                setDrawingState((prev) => ({ ...prev, layerType: layer }))
              }
            />
            <canvas
              className="layer-thumbnail"
              id={`${layer === "foreground" ? "fg" : "bg"}-thumbnail`}
              ref={
                layer === "foreground" ? fgThumbnailRef : bgThumbnailRef
              }
              onContextMenu={(e) => {
                e.preventDefault();
                if (layer === "foreground") {
                  setDrawingState((prev) => ({
                    ...prev,
                    fgVisible: !prev.fgVisible,
                  }));
                } else {
                  setDrawingState((prev) => ({
                    ...prev,
                    bgVisible: !prev.bgVisible,
                  }));
                }
              }}
              title={`Left click to select layer, right click to toggle visibility`}
            ></canvas>
            {layer === "foreground" ? "FG" : "BG"}
            <input
              type="checkbox"
              checked={
                layer === "foreground"
                  ? drawingState.fgVisible
                  : drawingState.bgVisible
              }
              onChange={(e) => {
                if (layer === "foreground") {
                  setDrawingState((prev) => ({
                    ...prev,
                    fgVisible: e.target.checked,
                  }));
                } else {
                  setDrawingState((prev) => ({
                    ...prev,
                    bgVisible: e.target.checked,
                  }));
                }
              }}
              title={`${
                layer === "foreground"
                  ? "Show/hide foreground"
                  : "Show/hide background"
              } layer`}
            />
          </label>
        ))}
      </div>

      <div id="zoom-controls">
        <button
          id="zoom-out-btn"
          type="button"
          onClick={() => handleZoomOut()}
        >
          -
        </button>
        <span id="zoom-level">{Math.round(currentZoom * 100)}%</span>
        <button
          id="zoom-in-btn"
          type="button"
          onClick={() => handleZoomIn()}
        >
          +
        </button>
        <button
          id="zoom-reset-btn"
          type="button"
          onClick={handleZoomReset}
        >
          Reset
        </button>
      </div>

      {/* Save button - only show for session owner */}
      {isSessionOwner && (
        <div id="save-controls">
          <button
            id="save-btn"
            type="button"
            onClick={saveCollaborativeDrawing}
            disabled={isSaving || sessionEnded || !joinResponseReceived}
            title={
              isSaving
                ? "Saving drawing..."
                : sessionEnded
                ? "Session ended"
                : !joinResponseReceived
                ? "Loading..."
                : "Save drawing to gallery"
            }
          >
            {isSaving ? "Saving..." : "💾 Save to Gallery"}
          </button>
        </div>
      )}
    </div>
  );
}