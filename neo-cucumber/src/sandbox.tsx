import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { i18n } from "@lingui/core";
import { setupI18n } from "./utils/i18n";
import { enableSandbox } from "./sandbox/bridge";
import { SandboxPage } from "./sandbox/SandboxPage";

enableSandbox();
setupI18n("en");

export const DefaultI18n = ({ children }: { children: React.ReactNode }) => (
  <span>{children}</span>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider i18n={i18n} defaultComponent={DefaultI18n}>
      <SandboxPage />
    </I18nProvider>
  </StrictMode>
);
