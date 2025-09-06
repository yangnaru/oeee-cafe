/**
 * Utility functions for generating consistent user colors based on usernames
 */

export interface UserColors {
  textColor: string;
  backgroundColor: string;
}

/**
 * Generate consistent colors for a user based on their username
 * This is derived from the getUserStyle function in Chat.tsx
 */
export const getUserColors = (username: string): UserColors => {
  // Improved hash function with better distribution for similar strings
  let hash = 5381; // Use DJB2 hash initial value
  
  // DJB2 hash algorithm with additional mixing
  for (let i = 0; i < username.length; i++) {
    const char = username.charCodeAt(i);
    hash = ((hash << 5) + hash) + char; // hash * 33 + char
  }
  
  // Apply additional mixing for better avalanche effect
  hash = Math.abs(hash);
  hash ^= hash >>> 16;
  hash *= 0x21f0aaad; // Large prime number
  hash ^= hash >>> 15;
  hash *= 0x735a2d97; // Another large prime
  hash ^= hash >>> 15;

  // Use hash to generate HSL color with better distribution
  // Apply modulo after all mixing is complete and ensure positive value
  const hue = Math.abs(hash % 360);
  const saturation = 75; // High saturation for vibrant colors

  // Generate contrasting text and background colors
  const textColor = `hsl(${hue}, ${saturation}%, 95%)`; // Light text
  const backgroundColor = `hsl(${hue}, ${saturation}%, 35%)`; // Dark background

  return {
    textColor,
    backgroundColor,
  };
};

/**
 * Get just the background color for a user (useful for icons)
 */
export const getUserBackgroundColor = (username: string): string => {
  return getUserColors(username).backgroundColor;
};