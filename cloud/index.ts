/**
 * cloud/index.ts — NeedMusic cloud proxy (deploys on Render's free tier).
 *
 * A small, dependency-light Node/TypeScript server that lets phone users run
 * online search WITHOUT being connected to the desktop's LAN server.
 *
 * Endpoints (all CORS-enabled for browsers, all no-auth — search is public):
 *   GET /online/search?q=...  → Bilibili (Wbi-signed) + YouTube (yt-dlp) search, JSON
 *   GET /online/audio?id=...&source=bilibili|youtube
 *                             → transcode + stream the matching audio as MP3
 *   GET /health               → tiny liveness probe (Render free tier pings this)
 *   GET /                     → JSON banner
 *
 * Bilibili is queried through its public API (Wbi-signed); YouTube is queried
 * with the yt-dlp CLI (installed in the Docker image). Both audio paths
 * transcode to MP3 with ffmpeg so the phone (incl. iOS Safari) can play them.
 *
 * Honest caveats: YouTube actively throttles datacenter/cloud IPs — search via
 * yt-dlp's flat-playlist usually works, but *audio extraction* for a given
 * video can fail with a "Sign in to confirm you're not a bot" (HTTP 403),
 * especially without a cookies file. When that happens the cloud reports a
 * clean error and the desktop LAN server remains the fallback.
 *
 * The desktop LAN server remains the fallback when no cloud URL is configured
 * or the cloud is unreachable.
 */

import * as http from "node:http";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORT = Number(process.env.PORT || 3001);

// Bilibili's fixed Wbi mixing table (from the frontend JS), 32 indices.
const MIXIN_TABLE: number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ─── Tiny helpers ─────────────────────────────────────

function urlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Extract the key token out of a Wbi img/sub URL (filename without ext).
function keyFromUrl(url: string): string {
  const path = url.split("/").pop() || "";
  const base = path.split(".").slice(0, -1).join(".") || path;
  return base;
}

// ─── Wbi signing (mirrors src-tauri/src/online.rs) ────

let cachedMixedKey: string | null = null;
let cachedKeyAt = 0;
const KEY_TTL_MS = 3600 * 1000; // 1 hour

// Bilibili uses a `buvid` (browser ID) cookie to classify guest traffic.
// Anonymous/cloud requests without it get throttled with HTTP 412 far more
// often. We fetch the nav page once to capture the cookie Bilibili assigns
// and reuse it for all subsequent requests (in-memory; re-obtained on restart
// or when it stops working).
let sessionCookie = "";
let cookieAt = 0;
const COOKIE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Ensure we hold a Bilibili session cookie (buvid3/buvid4). Best-effort. */
async function ensureCookie(): Promise<string> {
  const now = Date.now();
  if (sessionCookie && now - cookieAt < COOKIE_TTL_MS) return sessionCookie;
  try {
    const res = await fetch("https://www.bilibili.com/", {
      headers: { "User-Agent": USER_AGENT },
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const picked = setCookie
      .map((c) => c.split(";")[0])
      .filter((c) => /^buvid3=/i.test(c) || /^buvid4=/i.test(c))
      .join("; ");
    if (picked) {
      sessionCookie = picked;
      cookieAt = now;
    }
  } catch { /* best-effort */ }
  return sessionCookie;
}

/** Merge our session cookie into the given headers object if we have one. */
function withCookie(headers: Record<string, string>): Record<string, string> {
  if (sessionCookie) headers.Cookie = sessionCookie;
  return headers;
}

async function fetchWbiMixedKey(): Promise<string> {
  const now = Date.now();
  if (cachedMixedKey && now - cachedKeyAt < KEY_TTL_MS) return cachedMixedKey;

  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: withCookie({
      "User-Agent": USER_AGENT,
      Referer: "https://www.bilibili.com/",
    }),
  });
  if (!res.ok) throw new Error(`Wbi nav failed: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const wbi = json?.data?.wbi_img;
  const img = wbi?.img_url || "";
  const sub = wbi?.sub_url || "";
  if (!img || !sub) throw new Error("Wbi keys not found in nav response");
  const combined = keyFromUrl(img) + keyFromUrl(sub);
  const mixed = MIXIN_TABLE.map((i) => combined[i] ?? " ").join("");
  cachedMixedKey = mixed;
  cachedKeyAt = now;
  return mixed;
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Sign a params object with Wbi; returns the extra w_rid/wts pairs. */
async function signParams(params: Record<string, string>): Promise<Record<string, string>> {
  const mixedKey = await fetchWbiMixedKey();
  const wts = Math.floor(Date.now() / 1000).toString();
  const all: Record<string, string> = { ...params, wts };

  const sorted = Object.keys(all).sort();
  let toHash = "";
  for (const k of sorted) {
    const clean = all[k].replace(/[!'()*]/g, "");
    toHash += `${k}=${clean}&`;
  }
  toHash += mixedKey;

  const wRid = md5(toHash);
  const result: Record<string, string> = { w_rid: wRid, wts };
  return result;
}

// ─── Bilibili search ─────────────────────────────────

interface SearchItem {
  source: string;
  id: string;
  bvid: string;
  title: string;
  author: string;
  duration: string;
  duration_secs: number;
  cover_url: string;
  description: string;
  url: string;
}

interface SearchResponse {
  results: SearchItem[];
  total: number;
}

async function searchBilibili(query: string): Promise<SearchResponse> {
  // Establish a buvid session cookie first — it dramatically reduces the
  // 412 guest-throttle Bilibili applies to anonymous/cloud IPs.
  await ensureCookie();
  try {
    return await doSearchBilibili(query);
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    // Wbi keys expired (Bilibili code -799)? Clear the cache and retry once.
    if (msg.includes("-799")) {
      cachedMixedKey = null;
      return await doSearchBilibili(query);
    }
    // Guest throttle (HTTP 412)? Refresh the cookie and retry once after a
    // short backoff (mirrors the desktop's fetch_json_with_retry behaviour).
    if (msg.includes("412")) {
      await new Promise((r) => setTimeout(r, 800));
      sessionCookie = ""; // force a fresh buvid
      await ensureCookie();
      return await doSearchBilibili(query);
    }
    throw e;
  }
}

async function doSearchBilibili(query: string): Promise<SearchResponse> {
  const base = "https://api.bilibili.com/x/web-interface/search/type";
  const params: Record<string, string> = {
    search_type: "video",
    keyword: query,
    page: "1",
    page_size: "20",
  };
  const signed = await signParams(params);
  const all: Record<string, string> = { ...params, ...signed };

  const qs = Object.keys(all)
    .map((k) => `${urlEncode(k)}=${urlEncode(all[k])}`)
    .join("&");

  const res = await fetch(`${base}?${qs}`, {
    headers: withCookie({
      "User-Agent": USER_AGENT,
      Referer: "https://www.bilibili.com/",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    }),
  });
  if (!res.ok) throw new Error(`Bilibili search HTTP ${res.status}`);
  const json = (await res.json()) as any;

  // Non-zero code is an API-level failure (message carries the reason).
  if (json?.code !== 0 && json?.code !== undefined) {
    if (json?.code === -799) throw new Error("-799 Wbi keys expired");
    throw new Error(`Bilibili API error (${json?.code}): ${json?.message || "unknown"}`);
  }

  const results: SearchItem[] = [];
  const raw = json?.data?.result || [];
  for (const it of raw) {
    const bvid: string = it.bvid || "";
    if (!bvid) continue;
    const durationSecs = parseDuration(String(it.duration || "0:00"));
    const duration = fmtSecs(durationSecs);
    results.push({
      source: "bilibili",
      id: bvid,
      bvid,
      title: stripHtml(String(it.title || "")),
      author: String(it.author || ""),
      duration,
      duration_secs: durationSecs,
      cover_url: normalizeCover(String(it.pic || "")),
      description: stripHtml(String(it.description || "")),
      url: `https://www.bilibili.com/video/${bvid}`,
    });
  }

  return { results, total: Number(json?.data?.numResults) || results.length };
}

/** Parse a Bilibili duration token ("M:SS" or "H:MM:SS") into seconds. */
function parseDuration(s: string): number {
  const parts = s.split(":");
  const nums = parts.map((p) => Number(p.trim()) || 0).filter((n) => !isNaN(n));
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 1) return nums[0];
  return 0;
}

/** Format seconds the same way the desktop does (H:MM:SS when >= 1h). */
function fmtSecs(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "?:??";
  const t = Math.floor(secs);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}

/** Strip HTML tags and decode the common entities Bilibili returns. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Bilibili returns protocol-relative cover URLs ("//cdn..."); make them https. */
function normalizeCover(url: string): string {
  if (!url) return url;
  if (url.startsWith("//")) return "https:" + url;
  return url.replace(/^http:\/\//, "https://");
}

// ─── Audio stream proxy (Bilibili direct stream) ──────

/**
 * Resolve a bvid to a playable audio URL and stream it through this proxy.
 *
 * The phone asks for `/online/audio?id=BVxxx`; this server:
 *   1. Resolves the video's cid (needed to fetch streams).
 *   2. Fetches the DASH playurl (Wbi-signed, fnval=16 → separate audio).
 *   3. Picks the highest-bandwidth audio stream.
 *   4. Proxies it back to the client with CORS + Range support, so the
 *      browser on the phone can play it even though Bilibili's CDN blocks
 *      cross-origin audio.
 *
 * This is a "stream through" pass-through, NOT a transcode (the free tier has
 * no ffmpeg). Some guest/anonymous content has no accessible DASH audio — in
 * that case we return 404 and the client still shows the search results.
 */

/** Resolve a bvid → cid using the public video-info endpoint. */
async function getCid(bvid: string): Promise<number> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(url, {
    headers: withCookie({
      "User-Agent": USER_AGENT,
      Referer: `https://www.bilibili.com/video/${bvid}`,
    }),
  });
  if (!res.ok) throw new Error(`view API HTTP ${res.status}`);
  const json = (await res.json()) as any;
  if (json?.code !== 0) throw new Error(`view API error (${json?.code}): ${json?.message || "unknown"}`);
  const cid = Number(json?.data?.cid);
  if (!cid) throw new Error("no cid in view response");
  return cid;
}

const CACHE_DIR = path.join(os.tmpdir(), "needmusic-cloud-cache");
// Keep transcoded files for at most ~1 hour; drain on demand so a busy free
// tier stays within disk limits.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_FILES = 24;

function cachePath(bvid: string): string {
  return path.join(CACHE_DIR, `${bvid}.mp3`);
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function pruneCache(): void {
  try {
    const now = Date.now();
    let files = readdirSync(CACHE_DIR)
      .map((f) => {
        const p = path.join(CACHE_DIR, f);
        try { return { p, mtime: statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
      .sort((a, b) => a.mtime - b.mtime);
    // Drop expired entries.
    for (const f of files) {
      if (now - f.mtime > CACHE_TTL_MS) { try { rmSync(f.p); } catch { /* ignore */ } }
    }
    files = files.filter((f) => now - f.mtime <= CACHE_TTL_MS);
    // Keep at most CACHE_MAX_FILES — evict the oldest.
    while (files.length > CACHE_MAX_FILES) {
      try { rmSync(files.shift()!.p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Download a URL to a temp file (streamed). Returns the local path. */
async function downloadToFile(url: string, dest: string): Promise<string> {
  const res = await fetch(url, {
    headers: withCookie({
      "User-Agent": USER_AGENT,
      Referer: "https://www.bilibili.com/",
    }),
  });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  const { pipeline } = await import("node:stream/promises");
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    createWriteStream(dest)
  );
  return dest;
}

/**
 * Transcode Bilibili's DASH audio to a browser-playable MP3 (works on iOS,
 * matching how the desktop 'Save' converts with ffmpeg). Returns the MP3 path.
 */
async function getTranscoded(bvid: string, audioUrl: string): Promise<string> {
  ensureCacheDir();
  const out = cachePath(bvid);
  if (existsSync(out)) return out;

  // Download the raw DASH audio once, then transcode to MP3.
  const raw = path.join(CACHE_DIR, `${bvid}.raw`);
  try {
    await downloadToFile(audioUrl, raw);
    await runFfmpeg(raw, out);
    return out;
  } finally {
    try { rmSync(raw); } catch { /* ignore */ }
  }
}

/** ffmpeg -y -i <in> -vn -c:a libmp3lame -q:a 2 <out>.mp3  (same as the desktop). */
function runFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    execFile(
      ffmpeg,
      ["-y", "-i", input, "-map_metadata", "0", "-vn", "-c:a", "libmp3lame", "-q:a", "2", output],
      { timeout: 120_000 }, // free-tier CPU is slow; generous cap
      (err) => {
        if (err) reject(new Error("ffmpeg transcode failed: " + (err.message || String(err))));
        else resolve();
      }
    );
  });
}

/** Serve a local MP3 file with Range support (html5 <audio>/<video> seeking). */
function serveFile(cdn: http.ServerResponse, file: string): void {
  let size: number;
  try { size = statSync(file).size; } catch {
    cdn.statusCode = 404;
    cdn.end("transcoded file not available");
    return;
  }

  setCors(cdn);
  cdn.setHeader("Content-Type", "audio/mpeg");
  cdn.setHeader("Accept-Ranges", "bytes");

  const rangeHeader = cdn.req.headers.range;
  let start = 0;
  let end = size - 1;
  let code = 200;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] || m[2])) {
      start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2] || "0", 10);
      if (isNaN(start) || start < 0) start = 0;
      if (start >= size) {
        cdn.statusCode = 416;
        cdn.setHeader("Content-Range", `bytes */${size}`);
        cdn.end();
        return;
      }
      end = m[1] && m[2] ? (parseInt(m[2], 10) < size - 1 ? parseInt(m[2], 10) : size - 1) : size - 1;
      code = 206;
      cdn.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
  }
  cdn.statusCode = code;
  cdn.setHeader("Content-Length", (end - start + 1).toString());
  const stream = createReadStream(file, { start, end });
  stream.pipe(cdn);
  cdn.on("close", () => stream.destroy());
}

async function streamAudio(cdn: http.ServerResponse, bvid: string): Promise<void> {
  // 1) cid (required to get streams).
  const cid = await getCid(bvid);

  // 2) Wbi-signed DASH playurl.
  const params: Record<string, string> = {
    bvid,
    cid: String(cid),
    fnval: "16",
    fnver: "0",
    fourk: "1",
  };
  const signed = await signParams(params);
  const allParams: Record<string, string> = { ...params, ...signed };
  const qs = Object.keys(allParams)
    .map((k) => `${urlEncode(k)}=${urlEncode(allParams[k])}`)
    .join("&");
  const playUrl = `https://api.bilibili.com/x/player/playurl?${qs}`;

  const vres = await fetch(playUrl, {
    headers: withCookie({
      "User-Agent": USER_AGENT,
      Referer: `https://www.bilibili.com/video/${bvid}`,
    }),
  });
  if (!vres.ok) {
    cdn.statusCode = 502;
    cdn.end(`playurl fetch failed: HTTP ${vres.status}`);
    return;
  }
  const vjson = (await vres.json()) as any;
  if (vjson?.code === -799) {
    // Wbi keys expired — clear cache and one retry.
    cachedMixedKey = null;
  }
  if (vjson?.code !== 0) {
    cdn.statusCode = 404;
    cdn.end(`playurl API error (${vjson?.code})`);
    return;
  }

  // 3) Pick the highest-bandwidth DASH audio stream.
  const dash = vjson?.data?.dash;
  const audioStreams: any[] = dash?.audio ?? [];
  let audioUrl: string | null = null;
  let bestBw = -1;
  for (const s of audioStreams) {
    const bw = Number(s?.bandwidth) || 0;
    const url = String(s?.base_url || s?.baseUrl || "");
    if (bw > bestBw && url) { bestBw = bw; audioUrl = url; }
  }
  // Fall back to the non-DASH durl member if present.
  if (!audioUrl && vjson?.data?.durl?.[0]?.url) {
    audioUrl = vjson.data.durl[0].url;
  }
  if (!audioUrl) {
    cdn.statusCode = 404;
    cdn.end("no playable audio found for this video");
    return;
  }

  // 4) Download + transcode to MP3 (browser/iOS-playable), then serve it.
  pruneCache();
  let mp3: string;
  try {
    mp3 = await getTranscoded(bvid, audioUrl);
  } catch (e: any) {
    cdn.statusCode = 502;
    cdn.end(`transcode failed: ${(e && e.message) || e}`);
    return;
  }
  serveFile(cdn, mp3);
}

// ─── YouTube (yt-dlp) ────────────────────────────────

/**
 * Resolve the yt-dlp executable. Tries, in order:
 *   $YTDLP_PATH → `yt-dlp` on PATH → `python -m yt_dlp` → `python3 -m yt_dlp`.
 * The Render image installs a real `yt-dlp` binary, so the first candidate
 * usually wins there; the python fallbacks make local dev work without one.
 */
let ytDlpCmd: string[] | null = null;
async function resolveYtDlp(): Promise<string[]> {
  if (ytDlpCmd) return ytDlpCmd;
  const candidates: string[][] = [];
  if (process.env.YTDLP_PATH) candidates.push([process.env.YTDLP_PATH]);
  candidates.push(["yt-dlp"]);
  if (process.env.PYTHON_PATH) candidates.push([process.env.PYTHON_PATH, "-m", "yt_dlp"]);
  candidates.push(["python", "-m", "yt_dlp"]);
  candidates.push(["python3", "-m", "yt_dlp"]);
  for (const c of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(c[0], [...c.slice(1), "--version"], { timeout: 20_000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
      ytDlpCmd = c;
      return c;
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    "yt-dlp is required for YouTube search/audio. Install it (pip install yt-dlp) or set YTDLP_PATH."
  );
}

/** Run yt-dlp with args; resolves stdout, rejects with stderr on failure. */
function runYtDlp(args: string[], timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    resolveYtDlp()
      .then((cmd) => {
        execFile(
          cmd[0],
          [...cmd.slice(1), ...args],
          { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || "").trim() || (stdout || "").trim() || err.message;
              reject(new Error(`yt-dlp error: ${msg}`));
              return;
            }
            resolve((stdout || "").toString());
          }
        );
      })
      .catch(reject);
  });
}

/** Extract the 11-char video id from a YouTube URL (or accept a bare id). */
function extractYoutubeId(url: string): string | null {
  const bare = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(bare)) return bare;
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
  if (m) return m[1];
  for (const marker of ["youtu.be/", "/shorts/", "/embed/"]) {
    const pos = url.indexOf(marker);
    if (pos >= 0) {
      const rest = url.slice(pos + marker.length).split(/[?&#]/)[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(rest)) return rest;
    }
  }
  return null;
}

/** Search YouTube with yt-dlp's flat-playlist, mirroring the desktop. */
async function searchYoutube(query: string): Promise<SearchResponse> {
  const out = await runYtDlp([
    `ytsearch20:${query} music audio`,
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--no-check-certificate",
    "--socket-timeout", "15",
  ]);

  const results: SearchItem[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j: any;
    try { j = JSON.parse(t); } catch { continue; }
    const id = j?.id;
    if (!id) continue;

    // Flat-playlist returns a "thumbnails" array (not a "thumbnail" string);
    // take the last (highest-res) entry, then fall back to i.ytimg.com.
    let cover = Array.isArray(j.thumbnails) && j.thumbnails.length
      ? j.thumbnails[j.thumbnails.length - 1]?.url || ""
      : "";
    if (!cover && j.thumbnail) cover = j.thumbnail;
    if (!cover) cover = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    const dur = Number(j.duration) || 0;
    results.push({
      source: "youtube",
      id,
      bvid: id,
      title: j.title || "Unknown",
      author: j.uploader || j.channel || "Unknown",
      duration: fmtSecs(dur),
      duration_secs: dur,
      cover_url: cover,
      description: j.description || "",
      url: j.webpage_url || j.url || `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return { results, total: results.length };
}

/** Cached MP3 path for a YouTube video id (namespaced away from bvids). */
function cachePathYt(id: string): string {
  return path.join(CACHE_DIR, `yt-${id}.mp3`);
}

/**
 * Download a YouTube video's audio with yt-dlp, transcode to MP3 (same ffmpeg
 * path as Bilibili), cache it, and serve it with Range support.
 */
async function streamYoutubeAudio(cdn: http.ServerResponse, urlOrId: string): Promise<void> {
  const id = extractYoutubeId(urlOrId) || "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    cdn.statusCode = 400;
    cdn.end("invalid YouTube id/url");
    return;
  }
  const url = /^https?:\/\//i.test(urlOrId)
    ? urlOrId
    : `https://www.youtube.com/watch?v=${id}`;

  ensureCacheDir();
  const out = cachePathYt(id);
  if (existsSync(out)) { serveFile(cdn, out); return; }

  // Download best audio into a scratch dir (no ffmpeg needed to pick a single
  // format; we transcode to MP3 ourselves afterwards).
  const scratch = path.join(CACHE_DIR, `yt-dl-${id}`);
  mkdirSync(scratch, { recursive: true });
  try {
    await runYtDlp(
      [
        url,
        "-f", "bestaudio[ext=m4a]/bestaudio[ext=opus]/bestaudio/best",
        "-o", path.join(scratch, "%(id)s.%(ext)s"),
        "--no-playlist",
        "--no-warnings",
        "--no-check-certificate",
        "--socket-timeout", "30",
        "-R", "3",
        "--fragment-retries", "3",
        "--no-post-overwrites",
        "--no-part",
      ],
      240_000 // Python + ffmpeg on a free-tier CPU is slow; generous cap
    );
    const found = readdirSync(scratch).find((f) => f.startsWith(id) && !f.endsWith(".part"));
    if (!found) {
      cdn.statusCode = 502;
      cdn.end("yt-dlp completed but the output file was not found");
      return;
    }
    const raw = path.join(scratch, found);
    pruneCache();
    await runFfmpeg(raw, out);
    serveFile(cdn, out);
  } catch (e: any) {
    cdn.statusCode = 502;
    cdn.end(`YouTube audio failed: ${(e && e.message) || e}`);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── CORS ────────────────────────────────────────────

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  setCors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

// ─── HTTP server ─────────────────────────────────────

const server = http.createServer((req, res) => {
  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = u.pathname;

  if (path === "/") {
    sendJson(res, 200, { service: "needmusic-cloud", online_search: "/online/search?q=...", audio: "/online/audio?id=..." });
    return;
  }

  if (path === "/health") {
    res.statusCode = 200;
    setCors(res);
    res.end("ok");
    return;
  }

  if (path === "/online/search") {
    const q = u.searchParams.get("q") ?? "";
    if (!q.trim()) {
      sendJson(res, 400, { error: "missing q parameter" });
      return;
    }
    const query = q.trim();
    // Run Bilibili and YouTube in parallel; a failure in one source must not
    // kill the other (same tolerance as the desktop's combined search).
    Promise.allSettled([searchBilibili(query), searchYoutube(query)])
      .then(([bili, yt]) =>
        sendJson(res, 200, {
          bilibili: bili.status === "fulfilled" ? bili.value : { results: [], total: 0 },
          youtube: yt.status === "fulfilled" ? yt.value : { results: [], total: 0 },
          bilibili_error:
            bili.status === "rejected"
              ? String((bili.reason && (bili.reason as Error).message) || bili.reason)
              : null,
          youtube_error:
            yt.status === "rejected"
              ? String((yt.reason && (yt.reason as Error).message) || yt.reason)
              : null,
        })
      )
      .catch((e: any) => {
        // Shape like the desktop's combined result so the web UI renders identically.
        sendJson(res, 200, {
          bilibili: { results: [], total: 0 },
          youtube: { results: [], total: 0 },
          bilibili_error: String((e && e.message) || e),
          youtube_error: null,
        });
      });
    return;
  }

  if (path === "/online/audio") {
    const id = u.searchParams.get("id") ?? "";
    const source = (u.searchParams.get("source") ?? "bilibili").toLowerCase();
    if (!id) {
      sendJson(res, 400, { error: "missing id parameter" });
      return;
    }
    if (source === "youtube") {
      streamYoutubeAudio(res, id).catch((e: any) => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: String((e && e.message) || e) });
        } else {
          res.destroy();
        }
      });
    } else {
      ensureCookie().then(() => streamAudio(res, id)).catch((e: any) => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: String((e && e.message) || e) });
        } else {
          res.destroy();
        }
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`NeedMusic cloud proxy listening on :${PORT}`);
});
