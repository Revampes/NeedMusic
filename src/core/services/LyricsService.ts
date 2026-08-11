import { invoke } from "@tauri-apps/api/core";

/**
 * Lyrics support for online (Bilibili) tracks.
 *
 * Bilibili exposes LRC lyrics through its public player API. This service
 * fetches + parses them and caches per-track. YouTube has no public lyric
 * API — those tracks report "no lyrics".
 */

export interface LyricLine {
  /** Timestamp in seconds from the start of the track. */
  time: number;
  text: string;
}

class LyricsServiceClass {
  private cache = new Map<string, LyricLine[] | Promise<LyricLine[]>>();

  /**
   * Fetch parsed lyrics for a Bilibili track (cached).
   * Rejects when the video has no lyrics.
   */
  async getLyrics(trackId: string, bvid: string): Promise<LyricLine[]> {
    const hit = this.cache.get(trackId);
    if (hit) {
      return hit instanceof Promise ? hit : hit;
    }

    const promise = (async () => {
      const raw = await invoke<string>("get_online_lyrics", {
        source: "bilibili",
        idOrUrl: bvid,
      });
      return parseLrc(raw);
    })();

    this.cache.set(trackId, promise);
    try {
      const lines = await promise;
      this.cache.set(trackId, lines);
      return lines;
    } catch (e) {
      // Allow a later retry after a transient failure.
      this.cache.delete(trackId);
      throw e;
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Parse an LRC string into sorted lyric lines.
 * Handles `[mm:ss.xx]text`, multiple timestamps per line, and skips
 * metadata tags like `[offset:...]` / `[ti:...]`.
 */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const matches = [...line.matchAll(timeRe)];
    if (matches.length === 0) continue;

    const text = line.slice(line.lastIndexOf("]") + 1).trim();
    if (!text) continue; // instrumental gaps — skip empty lines

    for (const m of matches) {
      const min = parseInt(m[1], 10) || 0;
      const sec = parseInt(m[2], 10) || 0;
      const fracRaw = m[3] ?? "";
      let frac = 0;
      if (fracRaw.length === 1) frac = parseInt(fracRaw, 10) * 0.1;
      else if (fracRaw.length === 2) frac = parseInt(fracRaw, 10) * 0.01;
      else if (fracRaw.length === 3) frac = parseInt(fracRaw, 10) * 0.001;
      lines.push({ time: min * 60 + sec + frac, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * Index of the lyric line active at `timeSecs`, or -1 when before the first.
 */
export function findCurrentLine(lines: LyricLine[], timeSecs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= timeSecs) idx = i;
    else break;
  }
  return idx;
}

export const LyricsService = new LyricsServiceClass();
