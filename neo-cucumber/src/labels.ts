/**
 * The painter's vocabulary, for hosts.
 *
 * A host renders controls the painter does not own -- a Save button, a chat, a
 * session header -- and some of them name the same things the toolbox names. It
 * should be able to say "Pan" the way the column beside it says it, in whatever
 * language that column is currently speaking, without keeping its own copy of
 * NEO's word list and watching it go stale.
 *
 * This resolves against the package's own i18n, which is the one the painter
 * activates from its `locale` option. Read it after the painter is ready: a
 * painter that has not mounted has not chosen a language yet.
 */
import { i18n } from "@lingui/core";
import {
  resolvePainterLabels,
  type PainterLabelOverrides,
  type PainterLabels,
} from "./neo/labels";

export type { PainterLabelOverrides, PainterLabels };

/**
 * Every label the painter shows, in the locale it is running in.
 *
 * Overrides are applied on top, so a host that passed some to `mount` can pass
 * the same ones here and read back exactly what is on screen.
 */
export function painterLabels(
  overrides?: PainterLabelOverrides,
): PainterLabels {
  return resolvePainterLabels(i18n, overrides);
}
