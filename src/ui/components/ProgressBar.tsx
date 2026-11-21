import React, { useMemo } from "react";

interface ProgressBarProps {
  currentSecs: number;
  totalSecs: number;
  onSeek: (secs: number) => void;
  trackKey?: string;
}

function fmt(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ currentSecs, totalSecs, onSeek, trackKey = "" }) => {
  const pct = totalSecs > 0 ? (currentSecs / totalSecs) * 100 : 0;
  const waveform = useMemo(() => Array.from({ length: 72 }, (_, i) => {
    let hash = 0;
    for (let j = 0; j < trackKey.length; j++) hash = ((hash * 31) + trackKey.charCodeAt(j)) | 0;
    const seed = Math.sin((i + 1) * 12.9898 + Math.abs(hash) * 0.001) * 43758.5453;
    return 22 + Math.abs(seed - Math.floor(seed)) * 68;
  }), [trackKey]);

  const getRatio = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onSeek(getRatio(e) * totalSecs);
  };

  return (
    <div className="progress-bar-container">
      <span className="progress-time">{fmt(currentSecs)}</span>
      <div
        className="progress-track waveform-track"
        onClick={handleClick}
        role="slider"
        aria-label="Track progress"
        aria-valuemin={0}
        aria-valuemax={totalSecs}
        aria-valuenow={currentSecs}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onSeek(Math.max(0, currentSecs - 5));
          if (e.key === "ArrowRight") onSeek(Math.min(totalSecs, currentSecs + 5));
        }}
      >
        <div className="waveform-bars" aria-hidden="true">
          {waveform.map((height, i) => (
            <span
              key={i}
              className={i / waveform.length * 100 <= pct ? "is-played" : ""}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <div className="progress-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="progress-time">{fmt(totalSecs)}</span>
    </div>
  );
};

export default ProgressBar;
