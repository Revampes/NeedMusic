import { ColorExtractor, ColorPalette } from "@core/utils/ColorExtractor";

/**
 * BackgroundEngine — renders a fluid, animated canvas gradient background
 * that smoothly transitions colors based on album art extraction.
 *
 * Uses a grid of metaball-like gradient circles that morph and shift.
 * Falls back to a static dark gradient when no album art is available.
 *
 * Design Pattern: Singleton
 */
export class BackgroundEngine {
  private static instance: BackgroundEngine | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrame: number = 0;
  private currentPalette: ColorPalette;
  private targetPalette: ColorPalette;
  private transitionProgress: number = 1.0;
  private bubbles: Bubble[] = [];
  private width: number = 0;
  private height: number = 0;
  private dpr: number = 1;

  private constructor() {
    const extractor = ColorExtractor.getInstance();
    this.currentPalette = extractor.defaultPalette();
    this.targetPalette = extractor.defaultPalette();
  }

  static getInstance(): BackgroundEngine {
    if (!BackgroundEngine.instance) {
      BackgroundEngine.instance = new BackgroundEngine();
    }
    return BackgroundEngine.instance;
  }

  /**
   * Attach the engine to a canvas element and begin rendering.
   */
  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    this.initBubbles();
    this.start();
    window.addEventListener("resize", this.onResize);
  }

  /**
   * Stop rendering and detach.
   */
  unmount(): void {
    cancelAnimationFrame(this.animFrame);
    window.removeEventListener("resize", this.onResize);
    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Transition to a new palette extracted from album art.
   */
  async setArtwork(imageSrc: string): Promise<void> {
    const extractor = ColorExtractor.getInstance();
    this.targetPalette = await extractor.extract(imageSrc);
    this.transitionProgress = 0.0;
  }

  /**
   * Reset to default dark palette.
   */
  resetPalette(): void {
    const extractor = ColorExtractor.getInstance();
    this.targetPalette = extractor.defaultPalette();
    this.transitionProgress = 0.0;
  }

  // ─── Internal ──────────────────────────────────────────

  private onResize = (): void => {
    this.resize();
    this.initBubbles();
  };

  private resize(): void {
    if (!this.canvas) return;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this.ctx) {
      this.ctx.scale(this.dpr, this.dpr);
    }
  }

  private initBubbles(): void {
    this.bubbles = [];
    const count = Math.max(5, Math.floor((this.width * this.height) / 120000));
    for (let i = 0; i < count; i++) {
      this.bubbles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: 150 + Math.random() * 350,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        colorIndex: i % 4,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  private start(): void {
    const loop = () => {
      this.render();
      this.animFrame = requestAnimationFrame(loop);
    };
    this.animFrame = requestAnimationFrame(loop);
  }

  private render(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    // Check if glass mode — read from class or computed style.
    const isGlass = document.querySelector(".bg-canvas.glass-style") !== null
      || getComputedStyle(document.documentElement).getPropertyValue("--bg-style").trim() === "glass";
    const bubbleAlpha = isGlass ? 0.7 : 0.6;
    const bubbleAlpha2 = isGlass ? 0.3 : 0.18;
    const gridAlpha = isGlass ? 0.15 : 0.08;

    // Smooth palette transition.
    this.transitionProgress = Math.min(1, this.transitionProgress + 0.004);
    const p = this.lerpPalette(
      this.currentPalette,
      this.targetPalette,
      this.easeInOut(this.transitionProgress)
    );
    if (this.transitionProgress >= 1.0) {
      this.currentPalette = this.targetPalette;
    }

    // Background fill.
    ctx.fillStyle = p.darkMuted;
    ctx.fillRect(0, 0, this.width, this.height);

    // Soft radial glow in center.
    const centerGlow = ctx.createRadialGradient(
      this.width / 2, this.height / 2, 0,
      this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.6
    );
    const glowA = isGlass ? 0.15 : 0.5;
    const glowB = isGlass ? 0.05 : 0.25;
    centerGlow.addColorStop(0, this.hexToRgba(p.muted, glowA));
    centerGlow.addColorStop(0.5, this.hexToRgba(p.dominant, glowB));
    centerGlow.addColorStop(1, "transparent");
    ctx.fillStyle = centerGlow;
    ctx.fillRect(0, 0, this.width, this.height);

    // Animated gradient bubbles.
    const time = performance.now() * 0.0001;
    const colors = [p.vibrant, p.muted, p.dominant, p.darkMuted];

    for (const bubble of this.bubbles) {
      bubble.x += Math.sin(time * 0.7 + bubble.phase) * 0.4;
      bubble.y += Math.cos(time * 0.5 + bubble.phase) * 0.4;
      if (bubble.x < -bubble.r) bubble.x = this.width + bubble.r;
      if (bubble.x > this.width + bubble.r) bubble.x = -bubble.r;
      if (bubble.y < -bubble.r) bubble.y = this.height + bubble.r;
      if (bubble.y > this.height + bubble.r) bubble.y = -bubble.r;

      const pulse = 1 + Math.sin(time * 2 + bubble.phase) * 0.08;
      const r = bubble.r * pulse;

      const grad = ctx.createRadialGradient(bubble.x, bubble.y, 0, bubble.x, bubble.y, r);
      grad.addColorStop(0, this.hexToRgba(colors[bubble.colorIndex], bubbleAlpha));
      grad.addColorStop(0.5, this.hexToRgba(colors[bubble.colorIndex], bubbleAlpha2));
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(bubble.x - r, bubble.y - r, r * 2, r * 2);
    }

    // Subtle animated grid lines.
    ctx.strokeStyle = this.hexToRgba(p.muted, gridAlpha);
    ctx.lineWidth = 0.5;
    const gridSize = 80;
    const offsetX = (time * 15) % gridSize;
    const offsetY = (time * 8) % gridSize;
    for (let x = -gridSize + offsetX; x < this.width + gridSize; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (let y = -gridSize + offsetY; y < this.height + gridSize; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
  }

  private lerpPalette(a: ColorPalette, b: ColorPalette, t: number): ColorPalette {
    return {
      dominant: this.lerpHex(a.dominant, b.dominant, t),
      vibrant: this.lerpHex(a.vibrant, b.vibrant, t),
      muted: this.lerpHex(a.muted, b.muted, t),
      darkMuted: this.lerpHex(a.darkMuted, b.darkMuted, t),
    };
  }

  private lerpHex(a: string, b: string, t: number): string {
    const ar = parseInt(a.slice(1, 3), 16);
    const ag = parseInt(a.slice(3, 5), 16);
    const ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16);
    const bg = parseInt(b.slice(3, 5), 16);
    const bb = parseInt(b.slice(5, 7), 16);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${bl.toString(16).padStart(2,"0")}`;
  }

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  colorIndex: number;
  phase: number;
}
