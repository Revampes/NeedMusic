import React from "react";

interface ProgressBarProps {
  currentSecs: number;
  totalSecs: number;
  onSeek: (secs: number) => void;
}

function fmt(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ currentSecs, totalSecs, onSeek }) => {
  const pct = totalSecs > 0 ? (currentSecs / totalSecs) * 100 : 0;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(ratio * totalSecs);
  };

  return (
    <div className="progress-bar-container">
      <span className="progress-time">{fmt(currentSecs)}</span>
      <div className="progress-track" onClick={handleClick}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <div className="progress-thumb" style={{ left: `${pct}%` }} />
      </div>
      <span className="progress-time">{fmt(totalSecs)}</span>
    </div>
  );
};

export default ProgressBar;
