// Canvas Utilities
// Helper functions for color parsing, coordinate conversion, and common operations

interface ColorRgb {
    r: number;
    g: number;
    b: number;
}

export class CanvasUtils {
    // Color utilities
    static parseColor(color: string): ColorRgb {
        if (typeof color === 'string') {
            if (color.startsWith('#')) {
                const hex = color.substring(1);
                if (hex.length === 6) {
                    return {
                        r: parseInt(hex.substring(0, 2), 16),
                        g: parseInt(hex.substring(2, 4), 16),
                        b: parseInt(hex.substring(4, 6), 16)
                    };
                } else if (hex.length === 3) {
                    return {
                        r: parseInt(hex.substring(0, 1) + hex.substring(0, 1), 16),
                        g: parseInt(hex.substring(1, 2) + hex.substring(1, 2), 16),
                        b: parseInt(hex.substring(2, 3) + hex.substring(2, 3), 16)
                    };
                }
            } else if (color.startsWith('rgb')) {
                const match = color.match(/\d+/g);
                if (match && match.length >= 3) {
                    return {
                        r: parseInt(match[0]),
                        g: parseInt(match[1]),
                        b: parseInt(match[2])
                    };
                }
            }
        }
        return { r: 0, g: 0, b: 0 };
    }
    
    static rgbToHex(r: number, g: number, b: number): string {
        return '#' + [r, g, b].map(x => {
            const hex = Math.max(0, Math.min(255, Math.floor(x))).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }
    
    // Math utilities
    static clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }
    
    static distance(x1: number, y1: number, x2: number, y2: number): number {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    // Time utilities
    static getDateString(timestamp: number = Date.now()): string {
        return new Date(timestamp).toISOString().slice(0, 10);
    }
}