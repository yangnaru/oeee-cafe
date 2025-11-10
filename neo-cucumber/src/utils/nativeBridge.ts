/**
 * Native bridge for communicating with iOS and Android apps
 * Based on the pattern from legacy mobile templates
 */

interface NativeBridgeMessage {
  type: string;
  postId?: string;
  communityId?: string;
  imageUrl?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        oeee?: {
          postMessage: (message: NativeBridgeMessage) => void;
        };
      };
    };
    OeeeCafe?: {
      postMessage: (message: string) => void;
    };
  }
}

export const NativeBridge = {
  postMessage: (message: NativeBridgeMessage): void => {
    try {
      // iOS WKWebView
      if (window.webkit?.messageHandlers?.oeee) {
        window.webkit.messageHandlers.oeee.postMessage(message);
        return;
      }

      // Android WebView
      if (window.OeeeCafe?.postMessage) {
        window.OeeeCafe.postMessage(JSON.stringify(message));
        return;
      }

      // Fallback for web debugging
      console.log("NativeBridge message:", message);
    } catch (error) {
      console.error("NativeBridge error:", error);
    }
  },

  /**
   * Check if we're running in a native mobile app environment
   */
  isNativeEnvironment: (): boolean => {
    return !!(
      window.webkit?.messageHandlers?.oeee || window.OeeeCafe?.postMessage
    );
  },
};
