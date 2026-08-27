# NeedMusic Cloud Proxy

A small, free-tier–friendly web service that lets **phone users run online
search even when their computer (and the LAN server) is unreachable.**

It is a **search + playback proxy**: it takes a query, asks **Bilibili's public
API** and **YouTube (via yt-dlp)**, and returns results in the same shape the
desktop app uses. When the phone taps **Save**, the cloud downloads that video's
audio, transcodes it to MP3 (ffmpeg), and streams it back — no computer needed.

- How the web app uses it: it is one optional input in the phone app's
  **Settings → Cloud Search**. When set, online search tries the cloud first
  and falls back to your computer's LAN server automatically.
- What it never does: it stores nothing, logs nothing, and answers every
  request the same way a public read-only API does.

> **Honest caveat about YouTube on the cloud:** YouTube actively throttles
> datacenter/cloud IPs. yt-dlp **search** (flat-playlist) usually works, but
> **audio extraction** for a given video can fail with *"Sign in to confirm
> you're not a bot"* (HTTP 403) — especially without a cookies file. When that
> happens the cloud returns a clean error and the phone falls back to the
> desktop LAN server, which has cookies/history and is far more reliable for
> YouTube downloads. Bilibili has no such block and is the primary use case.

---

## Local development

```bash
cd cloud
npm install          # dev deps only (the server itself uses Node built-ins)
npm run dev          # Node 18+ runs index.ts via --experimental-strip-types
npm run typecheck    # tsc --noEmit
```

Test it:

```bash
curl "http://localhost:3001/health"                            # → ok
curl "http://localhost:3001/online/search?q=周杰伦"              # → JSON results
```

The audio endpoint `/online/audio?id=BVxxxxx` (Bilibili) or
`/online/audio?source=youtube&id=<videoIdOrUrl>` (YouTube) **downloads the
video's audio and transcodes it to MP3 with ffmpeg** before serving it back — a
plain MP3 plays on any phone browser, including iOS Safari (which refuses the
raw fMP4 that Bilibili serves). Transcoded files are cached per video for ~1
hour, so repeat plays/seek requests don't re-transcode. It requires **ffmpeg**
on `PATH` (or `FFMPEG_PATH`) and **yt-dlp** on `PATH` (or `YTDLP_PATH`) for the
YouTube path. If a video honestly has no accessible audio — or YouTube's
anti-bot blocks the cloud IP — it returns a clean HTTP error and the web app
shows what failed.

The `cloud/` dev deps include `ffmpeg-static`, so `npm install && npm start`
works locally even without a system ffmpeg; the server auto-detects it. yt-dlp
falls back to `python -m yt_dlp` when no `yt-dlp` binary is installed.

---

## Deploy to Render (free)

1. **Push this repo to GitHub** if you haven't already.
2. Go to **[https://dashboard.render.com/select-repo](https://dashboard.render.com/select-repo)**
   and choose this repository.
3. Render detects **`cloud/render.yaml`** and pre-fills a Web Service
   (Docker runtime, Free plan). Give it a name (e.g. `needmusic-cloud`).

   > **Start Command**: if Render marks the **Start Command** field as
   > *required* and blocks Apply until it's filled, paste exactly:
   > ```
   > node --experimental-strip-types cloud/index.ts
   > ```
   > Render runs this from the repo root (`/opt/render/project/src`), so the
   > `cloud/` prefix matters — the server file lives in the `cloud/` folder.
   > (The Dockerfile also defaults to this path, so leaving the field blank
   > works too when Render accepts it — but if it insists, use the string
   > above. No build step is needed; `node` runs the TypeScript directly.)

4. Click **Apply** and wait for the build (a minute or two). You get a live
   URL like `https://needmusic-cloud.onrender.com`.
5. In the phone web app open **Settings → Cloud Search**, paste
   `https://needmusic-cloud.onrender.com`, tap **Enable**. It tests the
   service, then saves it. Search now works without the computer.

> **Free-tier caveats (important)**
> - Render's free service **sleeps after ~15 minutes idle**. The first search
>   after that takes ~15–50s to cold-start, then runs normally.
> - Free bandwidth/CPU are limited and suitable for personal use. Don't expect
>   to serve many concurrent users.
> - There is **no rate-limit/auth** on this proxy (it's public by design for a
>   personal reader). Anyone with the URL can issue searches. If you'd rather
>   lock it down, add a token check behind an env var and pass the token in the
>   query string — the web app already reads `?cloud=...` and would forward it.

### Environment variables

| Var          | Default  | Meaning                                                                                       |
|--------------|----------|-----------------------------------------------------------------------------------------------|
| `PORT`       | `3001`   | Port Render assigns. Your Dockerfile + `render.yaml` already set it.                          |
| `FFMPEG_PATH`| `ffmpeg` | Full path to an ffmpeg binary. On Render it's installed via apt; set this only for custom setups. |
| `YTDLP_PATH` | `yt-dlp` | Full path to a yt-dlp binary. On Render it's installed via pip; set this only for custom setups. |

No other config is needed. Transcoding is essential for iOS playback, so the
cloud image bundles ffmpeg + yt-dlp (see the `Dockerfile`).
