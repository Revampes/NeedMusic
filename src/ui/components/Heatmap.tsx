import React, { useEffect, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { DatabaseManager } from "@core/services/DatabaseManager";

interface HeatmapProps {
  /** Optional override for number of weeks. Auto-computed to cover the full calendar year by default. */
  weeks?: number;
}

interface DayCell {
  date: string;   // "YYYY-MM-DD"
  count: number;  // play count
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  weekIndex: number;
  isToday: boolean;
  isFuture: boolean;
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
 * Columns = calendar weeks (Mon–Sun), always ending with the current week.
 */
const Heatmap: React.FC<HeatmapProps> = ({ weeks: weeksOverride }) => {
  const [history, setHistory] = useState<Map<string, number>>(new Map());
  const [tooltip, setTooltip] = useState<{ date: string; count: number; x: number; y: number } | null>(null);

  const todayStr = useMemo(() => formatLocalDate(new Date()), []);

  // Compute the calendar-anchored week count (always starts from Jan 1 week)
  const totalWeeks = useMemo(() => {
    if (weeksOverride !== undefined) return weeksOverride;
    const year = new Date().getFullYear();
    const jan1 = new Date(year, 0, 1);
    const jan1Dow = jan1.getDay();
    const jan1MondayOffset = jan1Dow === 0 ? 6 : jan1Dow - 1;
    const start = new Date(jan1);
    start.setDate(jan1.getDate() - jan1MondayOffset);
    const dec31 = new Date(year, 11, 31);
    const dec31Dow = dec31.getDay();
    const dec31SundayOffset = dec31Dow === 0 ? 0 : 7 - dec31Dow;
    const end = new Date(dec31);
    end.setDate(dec31.getDate() + dec31SundayOffset);
    return Math.ceil((end.getTime() - start.getTime()) / 86_400_000 / 7);
  }, [weeksOverride]);

  useEffect(() => {
    let cancelled = false;
    DatabaseManager.getInstance().getPlayHistory(totalWeeks * 7).then((map) => {
      if (!cancelled) setHistory(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [totalWeeks]);

  // Build the grid — anchored to Jan 1, covers the full calendar year
  const { cells, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const year = today.getFullYear();

    // Monday of the week containing Jan 1
    const jan1 = new Date(year, 0, 1);
    const jan1Dow = jan1.getDay();
    const jan1MondayOffset = jan1Dow === 0 ? 6 : jan1Dow - 1;
    const startDate = new Date(jan1);
    startDate.setDate(jan1.getDate() - jan1MondayOffset);

    // Sunday of the week containing Dec 31
    const dec31 = new Date(year, 11, 31);
    const dec31Dow = dec31.getDay();
    const dec31SundayOffset = dec31Dow === 0 ? 0 : 7 - dec31Dow;
    const endDate = new Date(dec31);
    endDate.setDate(dec31.getDate() + dec31SundayOffset);

    const msPerDay = 86_400_000;
    const computedWeeks = Math.ceil((endDate.getTime() - startDate.getTime()) / msPerDay / 7);
    const displayWeeks = weeksOverride ?? computedWeeks;
    const totalDays = displayWeeks * 7;

    const cellsArr: DayCell[] = [];

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = formatLocalDate(d);
      const dowCell = d.getDay(); // 0=Sun
      const weekIdx = Math.floor(i / 7);
      const isToday = dateStr === todayStr;
      const isFuture = d > today;

      cellsArr.push({
        date: dateStr,
        count: isFuture ? 0 : (history.get(dateStr) ?? 0),
        dayOfWeek: dowCell,
        weekIndex: weekIdx,
        isToday,
        isFuture,
      });
    }

    // Compute month labels: show month name at first column of each month
    const monthLbls: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;
    for (const cell of cellsArr) {
      const m = new Date(cell.date + "T00:00:00").getMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        monthLbls.push({ label: MONTH_NAMES[m], weekIndex: cell.weekIndex });
      }
    }

    return { cells: cellsArr, monthLabels: monthLbls };
  }, [history, todayStr, weeksOverride]);

  // Group cells into a 2D grid: rows=days of week (Mon=0..Sun=6), cols=weeks
  const grid = useMemo(() => {
    const dowToRow = (dow: number) => (dow === 0 ? 6 : dow - 1);
    const g: (DayCell | null)[][] = Array.from({ length: 7 }, () => Array(totalWeeks).fill(null));
    for (const cell of cells) {
      const row = dowToRow(cell.dayOfWeek);
      g[row][cell.weekIndex] = cell;
    }
    return g;
  }, [cells, totalWeeks]);

  const totalPlays = useMemo(() => {
    let sum = 0;
    for (const c of history.values()) sum += c;
    return sum;
  }, [history]);

  const handleMouseEnter = useCallback((e: React.MouseEvent, cell: DayCell) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({
      date: cell.date,
      count: cell.count,
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const tooltipPortal = tooltip
    ? createPortal(
        <div
          className="heatmap-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <strong>{tooltip.count} play{tooltip.count !== 1 ? "s" : ""}</strong> on {tooltip.date}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="heatmap-wrapper">
      <div className="heatmap-header">
        <h3 className="heatmap-title">Listening Activity</h3>
        <span className="heatmap-total">{totalPlays} plays in {new Date().getFullYear()}</span>
      </div>

      <div className="heatmap-scroll">
        <div className="heatmap-grid-area">
          {/* Month labels row */}
          <div className="heatmap-month-row">
            <div className="heatmap-day-label-spacer" />
            <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${totalWeeks}, 13px)` }}>
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
            <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${totalWeeks}, 13px)` }}>
              {grid.map((row, rowIdx) =>
                row.map((cell, colIdx) => (
                  <div
                    key={`${rowIdx}-${colIdx}`}
                    className={`heatmap-cell intensity-${cell ? getIntensity(cell.count) : 0}${cell?.isToday ? " today" : ""}${cell?.isFuture ? " future" : ""}`}
                    onMouseEnter={cell ? (e) => handleMouseEnter(e, cell) : undefined}
                    onMouseLeave={handleMouseLeave}
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

      {tooltipPortal}
    </div>
  );
};

export default Heatmap;
