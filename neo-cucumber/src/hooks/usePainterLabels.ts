import { createContext, useContext } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  resolvePainterLabels,
  type PainterLabelOverrides,
  type PainterLabels,
} from "../neo/labels";

/**
 * A host's replacements for the painter's own words, if it gave any.
 *
 * Context rather than a module variable because two painters can share a page
 * and need not agree -- and rather than props because the labels are wanted at
 * the bottom of the toolbox, several components below whoever was handed them.
 */
export const PainterLabelContext = createContext<PainterLabelOverrides | undefined>(
  undefined,
);

/** Every label, in the painter's locale, with the host's overrides applied. */
export function usePainterLabels(): PainterLabels {
  const { i18n } = useLingui();
  const overrides = useContext(PainterLabelContext);
  return resolvePainterLabels(i18n, overrides);
}
