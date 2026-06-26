/**
 * ColorExtractor — extracts dominant colors from album art images.
 * Uses canvas-based pixel sampling for palette generation.
 *
 * Design Pattern: Strategy (different sampling strategies)
 */
export interface ColorPalette {
  dominant: string;       // Most common hue
  vibrant: string;        // Bright, saturated accent
  muted: string;          // Desaturated background tone
  darkMuted: string;      // Dark background variant
}

export class ColorExtractor {
  private static instance: ColorExtractor | null = null;

  private constructor() {}

  static getInstance(): ColorExtractor {
    if (!ColorExtractor.instance) {
      ColorExtractor.instance = new ColorExtractor();
    }
    return ColorExtractor.instance;
  }

  /**
   * Extract a color palette from an image URL or element.
   * Returns a default dark palette on failure.
   */
  async extract(imageSrc: string): Promise<ColorPalette> {
    try {
      const img = await this.loadImage(imageSrc);
      const pixels = this.samplePixels(img, 50);
      return this.buildPalette(pixels);
    } catch {
      return this.defaultPalette();
    }
  }

  /**
   * Extract palette directly from an HTMLImageElement.
   */
  extractFromElement(img: HTMLImageElement): ColorPalette {
    const pixels = this.samplePixels(img, 50);
    return this.buildPalette(pixels);
  }

  defaultPalette(): ColorPalette {
    return {
      dominant: "#252525",
      vibrant: "#e94560",
      muted: "#1e1e1e",
      darkMuted: "#1a1a1a",
    };
  }

  // ─── Internal ──────────────────────────────────────────

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  private samplePixels(img: HTMLImageElement, sampleSize: number): RGB[] {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    // Downscale for performance.
    const w = Math.min(img.width, 100);
    const h = Math.min(img.height, 100);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const pixels: RGB[] = [];

    // Collect all non-transparent pixels.
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }

    if (pixels.length === 0) {
      return [{ r: 30, g: 30, b: 30 }];
    }

    // Sample evenly.
    const step = Math.max(1, Math.floor(pixels.length / sampleSize));
    const sampled: RGB[] = [];
    for (let i = 0; i < pixels.length; i += step) {
      sampled.push(pixels[i]);
    }
    return sampled;
  }

  private buildPalette(pixels: RGB[]): ColorPalette {
    // Cluster by hue buckets for dominant color.
    const hueBuckets = this.clusterByHue(pixels);

    // Dominant: the largest hue bucket averaged.
    const dominant = this.averageColor(hueBuckets[0] ?? pixels);

    // Vibrant: find the most saturated pixel in the dominant hue range.
    const vibrant = this.findMostSaturated(hueBuckets[0] ?? pixels);

    // Muted: desaturate the dominant color.
    const muted = this.desaturate(dominant, 0.3);

    // DarkMuted: darker variant of muted.
    const darkMuted = this.darken(muted, 0.5);

    return {
      dominant: this.rgbToHex(dominant),
      vibrant: this.rgbToHex(vibrant),
      muted: this.rgbToHex(muted),
      darkMuted: this.rgbToHex(darkMuted),
    };
  }

  private clusterByHue(pixels: RGB[]): RGB[][] {
    const buckets: RGB[][] = [[], [], [], [], [], []]; // 6 hue buckets
    for (const p of pixels) {
      const hsl = this.rgbToHsl(p);
      const bucket = Math.min(5, Math.floor(hsl.h / 60));
      buckets[bucket].push(p);
    }
    // Sort buckets by size descending.
    buckets.sort((a, b) => b.length - a.length);
    return buckets;
  }

  private findMostSaturated(pixels: RGB[]): RGB {
    let best = pixels[0] ?? { r: 233, g: 69, b: 96 };
    let bestSat = -1;
    for (const p of pixels) {
      const hsl = this.rgbToHsl(p);
      if (hsl.s > bestSat) {
        bestSat = hsl.s;
        best = p;
      }
    }
    // Boost saturation.
    const hsl = this.rgbToHsl(best);
    hsl.s = Math.min(1, hsl.s * 1.3);
    hsl.l = Math.max(0.3, Math.min(0.6, hsl.l));
    return this.hslToRgb(hsl);
  }

  private averageColor(pixels: RGB[]): RGB {
    if (pixels.length === 0) return { r: 30, g: 30, b: 30 };
    let r = 0, g = 0, b = 0;
    for (const p of pixels) {
      r += p.r; g += p.g; b += p.b;
    }
    return {
      r: Math.round(r / pixels.length),
      g: Math.round(g / pixels.length),
      b: Math.round(b / pixels.length),
    };
  }

  private desaturate(c: RGB, factor: number): RGB {
    const hsl = this.rgbToHsl(c);
    hsl.s *= factor;
    return this.hslToRgb(hsl);
  }

  private darken(c: RGB, factor: number): RGB {
    return {
      r: Math.round(c.r * factor),
      g: Math.round(c.g * factor),
      b: Math.round(c.b * factor),
    };
  }

  // ─── Color Space Conversions ───────────────────────────

  private rgbToHsl(c: RGB): HSL {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
    return { h: h * 360, s, l };
  }

  private hslToRgb(c: HSL): RGB {
    const h = c.h / 360, s = c.s, l = c.l;
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(this.hueToRgb(p, q, h + 1 / 3) * 255),
      g: Math.round(this.hueToRgb(p, q, h) * 255),
      b: Math.round(this.hueToRgb(p, q, h - 1 / 3) * 255),
    };
  }

  private hueToRgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  private rgbToHex(c: RGB): string {
    const r = c.r.toString(16).padStart(2, "0");
    const g = c.g.toString(16).padStart(2, "0");
    const b = c.b.toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }
}

interface RGB { r: number; g: number; b: number }
interface HSL { h: number; s: number; l: number }
