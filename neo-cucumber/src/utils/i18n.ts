import { i18n } from "@lingui/core";
import { messages as enMessages } from "../locales/en/messages";
import { messages as jaMessages } from "../locales/ja/messages";
import { messages as koMessages } from "../locales/ko/messages";
import { messages as zhMessages } from "../locales/zh/messages";

// Locale messages mapping
const localeMessages = {
  en: enMessages,
  ko: koMessages,
  ja: jaMessages,
  zh: zhMessages,
};

/**
 * Set up i18n with the specified locale
 * Falls back to English if the locale is not supported
 */
export const setupI18n = (locale: string) => {
  const messages =
    localeMessages[locale as keyof typeof localeMessages] || localeMessages.en;
  i18n.load(locale, messages);
  i18n.activate(locale);
};

/**
 * Fetch user's preferred locale from auth endpoint
 * Returns null if auth fails or no preferred locale is set
 */
export const fetchPreferredLocale = async (): Promise<string | null> => {
  try {
    const authResponse = await fetch("/api/auth", {
      method: "GET",
      credentials: "include",
    });

    if (!authResponse.ok) {
      return null;
    }

    const authInfo = await authResponse.json();
    return authInfo.preferred_locale || null;
  } catch (error) {
    console.error("Failed to fetch preferred locale:", error);
    return null;
  }
};
