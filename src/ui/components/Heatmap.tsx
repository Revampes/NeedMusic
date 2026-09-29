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
  seconds: number; // listened seconds
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  weekIndex: number;
  isToday: boolean;
  isFuture: boolean;
}

interface DayActivity {
  count: number;
  seconds: number;
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
 * Formats listened seconds as a human duration ("3h 12m", "12m", "0m").
 */
function formatListeningTime(totalSecs: number): string {
  const secs = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
 * GitHub-style contribution heatmap for listening activity, plus per-month
 * plays and month/year listening-hour totals.
 * Columns = calendar weeks (Mon–Sun), always ending with the current week.
 */
const Heatmap: React.FC<HeatmapProps> = ({ weeks: weeksOverride }) => {
  const [activity, setActivity] = useState<Map<string, DayActivity>>(new Map());
  const [tooltip, setTooltip] = useState<{ date: string; count: number; seconds: number; x: number; y: number } | null>(null);

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

  // Fetch counts + listened seconds in one query (one row per active day).
  // `getDailyActivityMerged` prefers the cross-device totals written by the
  // Drive sync merge, falling back to this device's own history when sync is off.
  const loadActivity = useCallback(async () => {
    const map = await DatabaseManager.getInstance().getDailyActivityMerged(totalWeeks * 7);
    setActivity(map);
  }, [totalWeeks]);

  useEffect(() => {
    loadActivity().catch(() => { /* no history yet */ });
  }, [loadActivity]);

  // Re-read when a new day's activity lands (the parent bumps this on progress
  // flushes), so the totals stay fresh without a page reload.
  useEffect(() => {
    const onActivity = () => { loadActivity().catch(() => {}); };
    window.addEventListener("listeningActivity", onActivity);
    return () => window.removeEventListener("listeningActivity", onActivity);
  }, [loadActivity]);

  // ── Totals + per-month breakdown ──
  const stats = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const currentMonth = now.getMonth();

    const monthly = MONTH_NAMES.map((name, index) => ({ name, index, plays: 0, seconds: 0 }));
    let yearPlays = 0;
    let yearSeconds = 0;

    for (const [date, v] of activity) {
      const d = new Date(`${date}T00:00:00`);
      if (d.getFullYear() !== year) continue;
      yearPlays += v.count;
      yearSeconds += v.seconds;
      const bucket = monthly[d.getMonth()];
      if (bucket) {
        bucket.plays += v.count;
        bucket.seconds += v.seconds;
      }
    }

    const thisMonth = monthly[currentMonth] ?? { plays: 0, seconds: 0 };
    return {
      year,
      currentMonth,
      yearPlays,
      yearSeconds,
      monthPlays: thisMonth.plays,
      monthSeconds: thisMonth.seconds,
      monthly,
      maxMonthlyPlays: Math.max(1, ...monthly.map((m) => m.plays)),
    };
  }, [activity]);

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
      const day = isFuture ? undefined : activity.get(dateStr);

      cellsArr.push({
        date: dateStr,
        count: day?.count ?? 0,
        seconds: day?.seconds ?? 0,
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
  }, [activity, todayStr, weeksOverride]);

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

  const handleMouseEnter = useCallback((e: React.MouseEvent, cell: DayCell) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({
      date: cell.date,
      count: cell.count,
      seconds: cell.seconds,
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
          {tooltip.seconds > 0 && <> · {formatListeningTime(tooltip.seconds)}</>}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="heatmap-wrapper">
      <div className="heatmap-header">
        <h3 className="heatmap-title">Listening Activity</h3>
        <span className="heatmap-total">
          {stats.yearPlays} plays · {formatListeningTime(stats.yearSeconds)} in {stats.year}
        </span>
      </div>

      {/* ── Month / year totals ── */}
      <div className="listen-stats">
        <div className="listen-stat-card">
          <span className="listen-stat-label">This month</span>
          <span className="listen-stat-value">{stats.monthPlays} plays</span>
          <span className="listen-stat-sub">{formatListeningTime(stats.monthSeconds)} listened</span>
        </div>
        <div className="listen-stat-card">
          <span className="listen-stat-label">This year</span>
          <span className="listen-stat-value">{stats.yearPlays} plays</span>
          <span className="listen-stat-sub">{formatListeningTime(stats.yearSeconds)} listened</span>
        </div>
      </div>

      {/* ── Plays per month (current year) ── */}
      <div className="listen-monthly">
        <div className="listen-monthly-bars">
          {stats.monthly.map((m) => (
            <div
              key={m.name}
              className={`listen-monthly-col${m.index === stats.currentMonth ? " current" : ""}`}
              title={`${m.name}: ${m.plays} play${m.plays !== 1 ? "s" : ""} · ${formatListeningTime(m.seconds)}`}
            >
              <div className="listen-monthly-bar-slot">
                <div
                  className="listen-monthly-bar"
                  style={{ height: `${Math.round((m.plays / stats.maxMonthlyPlays) * 100)}%` }}
                />
              </div>
              <span className="listen-monthly-label">{m.name[0]}</span>
            </div>
          ))}
        </div>
        <span className="listen-monthly-caption">Plays per month · {stats.year}</span>
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
