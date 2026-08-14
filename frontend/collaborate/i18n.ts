import { i18n } from "@lingui/core";
import { messages as enMessages } from "./locales/en/messages";
import { messages as jaMessages } from "./locales/ja/messages";
import { messages as koMessages } from "./locales/ko/messages";
import { messages as zhMessages } from "./locales/zh/messages";

const messages = {
  en: enMessages,
  ja: jaMessages,
  ko: koMessages,
  zh: zhMessages,
};

export const setupI18n = (requestedLocale: string) => {
  const locale = requestedLocale in messages
    ? requestedLocale as keyof typeof messages
    : "en";
  i18n.load(locale, messages[locale]);
  i18n.activate(locale);
};

export const fetchPreferredLocale = async (): Promise<string | null> => {
  try {
    const response = await fetch("/api/auth", { credentials: "include" });
    if (!response.ok) return null;
    const auth = await response.json();
    return auth.preferred_locale || null;
  } catch (error) {
    console.error("Failed to fetch preferred locale:", error);
    return null;
  }
};
