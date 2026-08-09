import { Trans, useLingui } from "@lingui/react/macro";
import { CustomSlider } from "./CustomSlider";
import { TIMER_DURATIONS_MINUTES } from "../hooks/useDrawingTimer";
import {
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  TWO_TONE_BACKGROUND_PEN_INDEX,
  TWO_TONE_FOREGROUND_PEN_INDEX,
} from "../constants/drawing";

interface SimplifiedToolboxProps {
  brushSize: number;
  paletteColors: string[]; // Should be [backgroundColor, foregroundColor]
  selectedPaletteIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  timerMinutes: number;
  timerRemainingSeconds: number;
  onBrushSizeChange: (size: number) => void;
  onSelectPen: (index: number) => void;
  onTimerChange: (minutes: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
}

const formatRemaining = (seconds: number): string => {
  if (seconds > 60) return `${Math.ceil(seconds / 60)}m`;
  return `${seconds}s`;
};

export const SimplifiedToolbox = ({
  brushSize,
  paletteColors,
  selectedPaletteIndex,
  canUndo,
  canRedo,
  isSaving,
  timerMinutes,
  timerRemainingSeconds,
  onBrushSizeChange,
  onSelectPen,
  onTimerChange,
  onUndo,
  onRedo,
  onSave,
}: SimplifiedToolboxProps) => {
  const { t } = useLingui();
  const backgroundColor = paletteColors[TWO_TONE_BACKGROUND_PEN_INDEX] || "#ffffff";
  const foregroundColor = paletteColors[TWO_TONE_FOREGROUND_PEN_INDEX] || "#000000";

  const remaining = formatRemaining(timerRemainingSeconds);

  const shortcuts: [string, string][] = [
    ["X", t`Swap pens`],
    ["P / B", t`Foreground pen`],
    ["E", t`Background pen`],
    ["[ / ]", t`Pen size`],
    ["Ctrl+Z", t`Undo`],
    ["Ctrl+Y", t`Redo`],
  ];

  return (
    <div
      className="fixed right-4 top-20 bg-main border border-main p-4 flex flex-col gap-4"
      style={{
        width: "200px",
        zIndex: 1000,
      }}
    >
      {/* Pen Size Slider */}
      <div className="flex flex-col gap-2">
        <CustomSlider
          label={`Size: ${brushSize}`}
          min={MIN_BRUSH_SIZE}
          max={MAX_BRUSH_SIZE}
          value={brushSize}
          onChange={onBrushSizeChange}
        />
      </div>

      {/* Color Picker */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-semibold text-main">
          <Trans>Color</Trans>
        </label>
        <div className="flex gap-2">
          {/* Background Color */}
          <div
            className="flex flex-col items-center gap-1 cursor-pointer"
            onClick={() => onSelectPen(TWO_TONE_BACKGROUND_PEN_INDEX)}
          >
            <div
              className="w-10 h-10 border border-main"
              style={{ backgroundColor }}
            />
            <input
              type="radio"
              name="color-picker"
              checked={selectedPaletteIndex === TWO_TONE_BACKGROUND_PEN_INDEX}
              onChange={() => onSelectPen(TWO_TONE_BACKGROUND_PEN_INDEX)}
              className="cursor-pointer"
            />
          </div>

          {/* Foreground Color */}
          <div
            className="flex flex-col items-center gap-1 cursor-pointer"
            onClick={() => onSelectPen(TWO_TONE_FOREGROUND_PEN_INDEX)}
          >
            <div
              className="w-10 h-10 border border-main"
              style={{ backgroundColor: foregroundColor }}
            />
            <input
              type="radio"
              name="color-picker"
              checked={selectedPaletteIndex === TWO_TONE_FOREGROUND_PEN_INDEX}
              onChange={() => onSelectPen(TWO_TONE_FOREGROUND_PEN_INDEX)}
              className="cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Drawing Timer */}
      <div className="flex flex-col gap-2">
        <label htmlFor="drawing-timer" className="text-sm font-semibold text-main">
          <Trans>Timer</Trans>
        </label>
        <select
          id="drawing-timer"
          value={timerMinutes}
          onChange={(e) => onTimerChange(Number(e.target.value))}
          className="border border-main bg-main text-main p-1 cursor-pointer"
        >
          {TIMER_DURATIONS_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? t`Off` : t`${minutes} min`}
            </option>
          ))}
        </select>
        <div className="text-sm text-main">
          {timerMinutes > 0 ? (
            <Trans>Remaining: {remaining}</Trans>
          ) : (
            <Trans>Timer off</Trans>
          )}
        </div>
      </div>

      {/* Undo/Redo Buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="flex-1 px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trans>Undo</Trans>
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className="flex-1 px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trans>Redo</Trans>
        </button>
      </div>

      {/* Save Button */}
      <button
        type="button"
        onClick={onSave}
        disabled={isSaving}
        className="px-4 py-2 border border-main bg-main text-main cursor-pointer hover:bg-highlight hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSaving ? <Trans>Saving...</Trans> : <Trans>Save Drawing</Trans>}
      </button>

      {/* Keyboard Shortcuts */}
      <div className="flex flex-col gap-1 border-t border-main pt-3">
        <span className="text-sm font-semibold text-main">
          <Trans>Shortcuts</Trans>
        </span>
        <dl className="flex flex-col gap-1 text-xs text-main">
          {shortcuts.map(([keys, description]) => (
            <div key={keys} className="flex justify-between gap-2">
              <dt className="font-mono">{keys}</dt>
              <dd className="text-right">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
};
