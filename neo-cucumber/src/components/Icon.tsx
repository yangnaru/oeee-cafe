import { Icon as IconifyIcon, addCollection } from "@iconify/react";
import { materialSymbols } from "./materialSymbols";

/*
 * Left to itself, `@iconify/react` renders a placeholder for an icon it has
 * never seen and asks Iconify's API for the artwork, so every button in the
 * toolbox appears empty and then fills in a network round trip later. The
 * offline painter, which is bundled to run without a server, never fills them
 * in at all.
 *
 * Registering the bundled data at import time is what makes the icons paint
 * with the first frame: `IconifyIcon` renders a known icon synchronously and
 * makes no request for it. Everything that draws an icon goes through this
 * module so no call site can reintroduce the fetch by importing the component
 * straight from the package.
 */
addCollection(materialSymbols);

export interface IconProps {
  /** A bundled name, e.g. `material-symbols:undo`. See `materialSymbols`. */
  icon: string;
  width?: number;
  height?: number;
  className?: string;
}

/** An icon from the bundled collection, drawn without a network request. */
export const Icon = ({ icon, width, height, className }: IconProps) => (
  <IconifyIcon icon={icon} width={width} height={height} className={className} />
);
