import React, { useRef, useState, useEffect, useCallback } from "react";

interface MarqueeTextProps {
  children: React.ReactNode;
  /** Extra CSS class for the container */
  className?: string;
  /** Base pixels-per-second for the slide portion */
  baseSpeed?: number;
  /** Always scroll when the text overflows (e.g. the currently playing row) —
   *  phones have no hover, so this is how the title slides like Spotify. */
  active?: boolean;
}

/**
 * Displays text that scrolls horizontally when it overflows its container.
 * - Text stays clipped within its parent column (no overflow:visible)
 * - Only animates when text is actually wider than the container
 * - Pause → slide → pause → reset cycle
 * - Animates on hover (desktop), on touch (phones), and when `active`.
 *
 * The keyframe is fixed at: 0%-15% pause, 15%-75% slide, 75%-90% pause, 90%-100% reset.
 * Duration scales with text length so longer text doesn't fly by.
 */
const MarqueeText: React.FC<MarqueeTextProps> = ({
  children,
  className,
  baseSpeed = 55,
  active = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflowPx, setOverflowPx] = useState(0);
  const [hovering, setHovering] = useState(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;
    const cw = container.clientWidth;
    const sw = inner.scrollWidth;
    const overflow = sw - cw;
    setOverflowPx(Math.max(0, Math.ceil(overflow)));
  }, [children]);

  useEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    const inner = innerRef.current;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [children, measure]);

  const needsMarquee = (hovering || active) && overflowPx > 2;

  // The slide portion is 60% of the keyframe (15%→75%).
  // Total duration = slideTime / 0.6
  const slideSecs = Math.max(2, overflowPx / baseSpeed);
  const totalSecs = slideSecs / 0.6;

  return (
    <div
      ref={containerRef}
      className={`marquee-container ${className ?? ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onTouchStart={() => setHovering(true)}
      onTouchEnd={() => setTimeout(() => setHovering(false), 2500)}
    >
      <span
        ref={innerRef}
        className={`marquee-inner ${needsMarquee ? "marquee-active" : ""}`}
        style={
          needsMarquee
            ? {
                animationDuration: `${totalSecs}s`,
                ["--marquee-dist" as string]: `-${overflowPx}px`,
              }
            : undefined
        }
      >
        {children}
      </span>
    </div>
  );
};

export default MarqueeText;
