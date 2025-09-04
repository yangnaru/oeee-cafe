import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
import { messages as messagesEn } from "./locales/en/messages";

i18n.load({
  en: messagesEn,
});
i18n.activate("en");

export const DefaultI18n = ({ children }: { children: React.ReactNode }) => (
  <span>{children}</span>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider i18n={i18n} defaultComponent={DefaultI18n}>
      <App />
    </I18nProvider>
  </StrictMode>
);
