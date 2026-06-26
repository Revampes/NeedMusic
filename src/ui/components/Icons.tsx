import React from "react";

/* ═══════════════════════════════════════════════════════
   NeedMusic — Simple Monochrome SVG Icons
   All icons use currentColor, 24×24 viewBox, stroke-based.
   ═══════════════════════════════════════════════════════ */

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

const mk = (d: string, filled = false): React.FC<IconProps> => {
  const C: React.FC<IconProps> = ({ size = 18, className, style }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d={d} />
    </svg>
  );
  C.displayName = "Icon";
  return C;
};

/* ── Navigation ────────────────────────────────────── */
export const IconLibrary    = mk("M4 6h16M4 12h16M4 18h16");                          // 📚
export const IconHeart      = mk("M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"); // ❤️
export const IconHeartFill  = mk("M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z", true);
export const IconPlaylist   = mk("M9 5H4v4h5zM9 11H4v4h5zM9 17H4v4h5zM14 7h6M14 11h6M14 15h6M14 19h4"); // 📋
export const IconSettings   = mk("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"); // ⚙️

/* ── Player Controls ───────────────────────────────── */
export const IconPrevious  = mk("M19 20 9 12l10-8z M5 19V5");                         // ⏮
export const IconPlay      = mk("M5 3l14 9-14 9V3z", true);                            // ▶
export const IconPause     = mk("M6 4h4v16H6zM14 4h4v16h-4z");                         // ⏸
export const IconNext      = mk("M5 4l10 8-10 8V4z M19 5v14");                         // ⏭
export const IconStop      = mk("M6 6h12v12H6z");                                       // ⏹
export const IconShuffle   = mk("M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5");  // 🔀

/* ── Repeat ────────────────────────────────────────── */
export const IconRepeatOff   = mk("M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h11 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H6");
export const IconRepeat      = mk("M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3");
export const IconRepeatOne   = mk("M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3 M13 11l2-3h1v7h-1");

/* ── General ───────────────────────────────────────── */
export const IconMusic     = mk("M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"); // 🎵
export const IconImage     = mk("M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21"); // 🖼
export const IconVolume     = mk("M11 5 6 9H2v6h4l5 4V5z M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"); // 🔊
export const IconVolumeMute = mk("M11 5 6 9H2v6h4l5 4V5z M23 9l-6 6M17 9l6 6"); // 🔇
export const IconClock      = mk("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2"); // ⏱
export const IconPlus        = mk("M12 5v14M5 12h14");                                  // ＋
export const IconClose       = mk("M18 6 6 18M6 6l12 12");                              // ✕
export const IconDisc        = mk("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M12 15a1 1 0 0 0 1-1"); // 💿
export const IconMic         = mk("M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4M8 23h8"); // 🎤

/* ── Window Controls ───────────────────────────────── */
export const IconWinMin    = mk("M5 12h14");                                            // ─
export const IconWinMax    = mk("M5 5h14v14H5z");                                       // ◻
export const IconWinRestore = mk("M5 9h10v10H5z M15 5h4v4h-4z M11 5v4");               // restore (alt max)

/* ── Utility ───────────────────────────────────────── */
export const IconFolder    = mk("M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"); // 📁
export const IconPalette   = mk("M12 2a10 10 0 1 0 10 10c0-1.08-.17-2.11-.5-3.08a2 2 0 0 0-2.54-1.28c-1.13.47-1.78 1.73-1.1 2.85.38.59.14 1.51-.3 1.51H12a4 4 0 1 1 0-8.08c2.14-.33 4.49.51 5.67 2.08A10 10 0 1 0 12 2z M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M7.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M16.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M12 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"); // 🎨
export const IconRocket    = mk("M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0 M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"); // 🚀
export const IconCheck     = mk("M20 6 9 17l-5-5");                                     // ✅
export const IconAlert     = mk("M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4M12 17h.01"); // ❌ / generic alert
export const IconHourglass = mk("M5 22h14M5 2h14M12 8v5l4 4 M17 2.5H7a2 2 0 0 0-2 2v2.17a2 2 0 0 0 .59 1.42L9 11.5l-3.41 3.41A2 2 0 0 0 5 16.33V19a2 2 0 0 0 2 2"); // ⏳
export const IconGlobe     = mk("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"); // 🌐
