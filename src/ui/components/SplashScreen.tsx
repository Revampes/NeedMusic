import React from "react";
import { IconMusic } from "@ui/components/Icons";

interface SplashScreenProps {
  error?: string | null;
  onRetry?: () => void;
  fading?: boolean;
}

/**
 * Startup splash screen with animated audio-wave bars and centered logo.
 * Shows while the app initializes the database, audio engine, and services.
 */
const SplashScreen: React.FC<SplashScreenProps> = ({ error, onRetry, fading }) => {
  // Number of animated wave bars on each side of the logo.
  const BAR_COUNT = 14;

  return (
    <div className={`splash-root${fading ? " splash-fading" : ""}`}>
      {/* Ambient glow behind the logo */}
      <div className="splash-glow" />

      <div className="splash-content">
        {/* Audio wave bars — left side */}
        <div className="splash-wave-group">
          {Array.from({ length: BAR_COUNT }).map((_, i) => (
            <div
              key={`left-${i}`}
              className="splash-wave-bar"
              style={{
                animationDelay: `${i * 0.08}s`,
                height: `${18 + Math.sin((i / BAR_COUNT) * Math.PI) * 28}px`,
              }}
            />
          ))}
        </div>

        {/* Center logo + text */}
        <div className="splash-center">
          <div className="splash-icon-ring">
            <IconMusic size={44} />
          </div>
          <h1 className="splash-title">NeedMusic</h1>
        </div>

        {/* Audio wave bars — right side (mirrored) */}
        <div className="splash-wave-group">
          {Array.from({ length: BAR_COUNT }).map((_, i) => (
            <div
              key={`right-${i}`}
              className="splash-wave-bar"
              style={{
                animationDelay: `${i * 0.08 + 0.04}s`,
                height: `${18 + Math.sin(((BAR_COUNT - 1 - i) / BAR_COUNT) * Math.PI) * 28}px`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Status text / error */}
      <div className="splash-status">
        {error ? (
          <>
            <p className="splash-error-msg">{error}</p>
            {onRetry && (
              <button className="splash-retry-btn" onClick={onRetry}>
                Retry
              </button>
            )}
          </>
        ) : (
          <>
            <p className="splash-loading-text">Setting up your music experience</p>
            <div className="splash-progress-track">
              <div className="splash-progress-fill" />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SplashScreen;
