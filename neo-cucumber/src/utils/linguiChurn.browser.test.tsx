import { describe, expect, it } from "vitest";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import { i18n } from "@lingui/core";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Why initialisation must not depend on `t`.
 *
 * Activating a locale hands out a fresh `t`, and it does so even when the
 * locale being activated is the one already active. Mounting the painter
 * activates a locale, so anything keyed on `t` re-runs when the painter
 * mounts -- and if that anything is what fetches the session and sets the
 * state the painter is mounted from, the two chase each other around: mount,
 * activate, refetch, remount. That is what the collaborative editor was doing
 * when it flickered.
 *
 * This is third-party behaviour rather than ours, which is exactly why it is
 * pinned: it is the reason for an eslint-disable in the host, and nothing in
 * that comment would fail if Lingui changed its mind.
 */
describe("activating a locale", () => {
  it("hands out a new t even when the locale has not changed", async () => {
    i18n.load("en", {});
    i18n.activate("en");
    const seen: unknown[] = [];

    function Probe() {
      const { t } = useLingui();
      useEffect(() => {
        seen.push(t);
      }, [t]);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<I18nProvider i18n={i18n}><Probe /></I18nProvider>),
    );
    expect(seen).toHaveLength(1);

    // What mounting the painter does: setupI18n() loads and activates.
    await act(async () => {
      i18n.load("en", {});
      i18n.activate("en");
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);

    await act(async () => root.unmount());
    host.remove();
  });
});
