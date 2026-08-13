import { useEffect, useRef } from "react";
import {
  NEO_TIP_CANVAS,
  NEO_TIP_FIXED,
  NEO_TIP_LABEL,
  NEO_TIP_OFF,
  NEO_TIP_ON,
} from "./neoClasses";
import { paintTip, TIP_HEIGHT, TIP_WIDTH } from "../../neo/tipArtwork";
import type { NeoTipArt } from "../../neo/toolboxSpec";

interface NeoToolTipProps {
  art: NeoTipArt;
  label: string;
  /** Pressed. Ignored when `fixed`, which NEO never presses. */
  selected?: boolean;
  /** NEO's `toolTipFixed`: a setting rather than a tool. */
  fixed?: boolean;
  /** Drawing colour, "#rrggbb" -- most tips tint their artwork with it. */
  color: string;
  /** Alpha 0-255; only the halftone tip's dither reads it. */
  alpha: number;
  /** Mask colour, "#rrggbb"; only the mask tip reads it. */
  maskColor: string;
  title?: string;
  /**
   * A second sprite sitting behind the artwork, untinted. Only NEO's
   * Effect2Tip has one, and it has it in every mode rather than only on copy.
   */
  underlay?: string;
  /** Left button. NEO acts on press, not release. */
  onActivate: () => void;
  /** Right button, which in NEO steps backwards through the group. */
  onAlternate?: () => void;
}

/**
 * One of NEO's tool buttons: a 46x18 canvas with a label hanging off its
 * bottom edge.
 *
 * The artwork is painted rather than styled because it depends on live state
 * -- the sprite is a stencil tinted with the drawing colour, the halftone tip
 * dithers the current alpha, and the mask tip is a bar of the mask colour. See
 * neo/tipArtwork.ts for the three cases.
 */
export function NeoToolTip({
  art,
  label,
  selected = false,
  fixed = false,
  color,
  alpha,
  maskColor,
  title,
  underlay,
  onActivate,
  onAlternate,
}: NeoToolTipProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * `art` is rebuilt on every render, so depending on it directly would
   * repaint all nine tips on every keystroke and every frame of a slider
   * drag. Depend on what actually distinguishes one painting from another,
   * and read the rest through a ref.
   */
  const artKey =
    art.kind === "icon" ? `icon:${art.icon}:${art.tint}` : art.kind;
  const latest = useRef({ art, color, alpha, maskColor });
  latest.current = { art, color, alpha, maskColor };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return paintTip(canvas, latest.current);
  }, [artKey, color, alpha, maskColor]);

  const face = fixed ? NEO_TIP_FIXED : selected ? NEO_TIP_ON : NEO_TIP_OFF;

  return (
    <button
      type="button"
      className={face}
      title={title ?? label}
      aria-pressed={fixed ? undefined : selected}
      // NEO acts on mousedown, so a drag off the button still counts
      onPointerDown={(e) => {
        if (e.button === 2) return;
        onActivate();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        (onAlternate ?? onActivate)();
      }}
    >
      {/*
        The underlay is in normal flow while the artwork canvas is positioned,
        so the canvas paints over it -- which is what makes NEO's copy tool
        read as one page lying over another.
      */}
      {underlay && (
        <img src={underlay} alt="" className="pointer-events-none" />
      )}
      <canvas
        ref={canvasRef}
        width={TIP_WIDTH}
        height={TIP_HEIGHT}
        className={NEO_TIP_CANVAS}
      />
      <span className={NEO_TIP_LABEL}>{label}</span>
    </button>
  );
}
