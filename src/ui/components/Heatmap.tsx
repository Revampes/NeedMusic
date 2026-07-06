import React, { useEffect, useState, useMemo } from "react";
import { DatabaseManager } from "@core/services/DatabaseManager";

interface HeatmapProps {
  /** Number of weeks to display (each week = 7 days). Default 26 (~6 months). */
  weeks?: number;
}

interface DayCell {
  date: string;   // "YYYY-MM-DD"
  count: number;  // play count
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  weekIndex: number;
  isToday: boolean;
}

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Formats a Date as "YYYY-MM-DD" in local time (avoids UTC timezone shifts). */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns an intensity class (0-4) based on play count.
 */
function getIntensity(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

/**
 * GitHub-style contribution heatmap for listening activity.
 */
const Heatmap: React.FC<HeatmapProps> = ({ weeks = 26 }) => {
  const [history, setHistory] = useState<Map<string, number>>(new Map());
  const [tooltip, setTooltip] = useState<{ date: string; count: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    DatabaseManager.getInstance().getPlayHistory(weeks * 7).then((map) => {
      if (!cancelled) setHistory(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [weeks]);

  // Build the grid of day cells
  const { cells, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Align to the start of the week (Monday)
    const dayOfWeek = today.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // days since Monday
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (weeks * 7 - 1) - mondayOffset);
    // Align startDate to Monday
    const startDow = startDate.getDay();
    const startMondayOffset = startDow === 0 ? 6 : startDow - 1;
    startDate.setDate(startDate.getDate() - startMondayOffset);

    const cellsArr: DayCell[] = [];
    const totalDays = weeks * 7;

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = formatLocalDate(d);
      const dow = d.getDay(); // 0=Sun
      const weekIdx = Math.floor(i / 7);
      const isToday = dateStr === formatLocalDate(today);

      cellsArr.push({
        date: dateStr,
        count: history.get(dateStr) ?? 0,
        dayOfWeek: dow,
        weekIndex: weekIdx,
        isToday,
      });
    }

    // Compute month labels: show month name at first week of each month
    const monthLbls: { label: string; weekIndex: number }[] = [];
    for (const cell of cellsArr) {
      if (cell.dayOfWeek === 1) { // Monday
        const m = new Date(cell.date).getMonth();
        const prev = monthLbls[monthLbls.length - 1];
        if (!prev || new Date(cellsArr[(prev.weekIndex) * 7]?.date ?? "").getMonth() !== m) {
          monthLbls.push({ label: MONTH_NAMES[m], weekIndex: cell.weekIndex });
        }
      }
    }

    return { cells: cellsArr, monthLabels: monthLbls };
  }, [history, weeks]);

  // Group cells into a 2D grid: rows=days of week (Mon=1..Sun=0), cols=weeks
  const grid = useMemo(() => {
    // Map dayOfWeek to row: Mon=0, Tue=1, ..., Sun=6
    const dowToRow = (dow: number) => (dow === 0 ? 6 : dow - 1);
    const g: (DayCell | null)[][] = Array.from({ length: 7 }, () => Array(weeks).fill(null));
    for (const cell of cells) {
      const row = dowToRow(cell.dayOfWeek);
      g[row][cell.weekIndex] = cell;
    }
    return g;
  }, [cells, weeks]);

  const totalPlays = useMemo(() => {
    let sum = 0;
    for (const c of history.values()) sum += c;
    return sum;
  }, [history]);

  return (
    <div className="heatmap-wrapper">
      <div className="heatmap-header">
        <h3 className="heatmap-title">Listening Activity</h3>
        <span className="heatmap-total">{totalPlays} plays in the last {weeks} weeks</span>
      </div>

      <div className="heatmap-scroll">
        <div className="heatmap-grid-area">
          {/* Month labels row */}
          <div className="heatmap-month-row">
            <div className="heatmap-day-label-spacer" />
            <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks}, 13px)` }}>
              {monthLabels.map((ml, i) => (
                <span
                  key={i}
                  className="heatmap-month-label"
                  style={{ gridColumn: ml.weekIndex + 1 }}
                >
                  {ml.label}
                </span>
              ))}
            </div>
          </div>

          {/* Grid + day labels */}
          <div className="heatmap-body">
            <div className="heatmap-day-labels">
              {DAY_LABELS.map((label, i) => (
                <div key={i} className="heatmap-day-label">{label}</div>
              ))}
            </div>
            <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 13px)` }}>
              {grid.map((row, rowIdx) =>
                row.map((cell, colIdx) => (
                  <div
                    key={`${rowIdx}-${colIdx}`}
                    className={`heatmap-cell intensity-${cell ? getIntensity(cell.count) : 0}${cell?.isToday ? " today" : ""}`}
                    onMouseEnter={(e) => {
                      if (!cell) return;
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({
                        date: cell.date,
                        count: cell.count,
                        x: rect.left + rect.width / 2,
                        y: rect.top - 8,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {cell?.isToday && <div className="heatmap-today-dot" />}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div key={level} className={`heatmap-cell intensity-${level} heatmap-legend-cell`} />
        ))}
        <span className="heatmap-legend-label">More</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="heatmap-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <strong>{tooltip.count} play{tooltip.count !== 1 ? "s" : ""}</strong> on {tooltip.date}
        </div>
      )}
    </div>
  );
};

export default Heatmap;
