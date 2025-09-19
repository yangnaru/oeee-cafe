import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
import { messages as messagesEn } from "./locales/en/messages";
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "https://930f2aecbd98603e4dd1651924c1004a@o4504757655764992.ingest.us.sentry.io/4510046135582720",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});

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
