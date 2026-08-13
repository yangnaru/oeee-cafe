import { NEO_RESERVE, NEO_RESERVE_CONTROL } from "./neoClasses";
import type { NeoReserve } from "../../neo/toolboxSpec";

interface NeoReserveControlProps {
  reserves: readonly NeoReserve[];
  /** Left click: adopt everything the slot holds. */
  onLoad: (index: number) => void;
  /** Right click: overwrite the slot with the current settings. */
  onSave: (index: number) => void;
}

/**
 * NEO's three tool memories.
 *
 * Each slot holds a whole setup -- tool, colour, size, alpha and draw type --
 * not just a colour, so the swatch you see is only the part of it that can be
 * shown. Left click loads a slot, right click saves the current settings into
 * it. It ships preloaded with a black 1px pen and two white erasers, which is
 * why two of the three start out looking blank.
 */
export function NeoReserveControl({
  reserves,
  onLoad,
  onSave,
}: NeoReserveControlProps) {
  return (
    <div className={NEO_RESERVE_CONTROL}>
      {reserves.map((reserve, index) => (
        <button
          key={index}
          type="button"
          className={NEO_RESERVE}
          // ReserveControl.init: 15px apart, starting 2px in
          style={{ left: index * 15 + 2, backgroundColor: reserve.color }}
          title={`Slot ${index + 1}: ${reserve.tool} ${reserve.size}px — click to load, right-click to save`}
          onPointerDown={(e) => {
            if (e.button === 2) return;
            onLoad(index);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onSave(index);
          }}
        />
      ))}
    </div>
  );
}
