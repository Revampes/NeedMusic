# NeedMusic Cloud Proxy

A small, free-tier–friendly web service that lets **phone users run Bilibili
online search even when their computer (and the LAN server) is unreachable.**

It is a **search-only** proxy: it takes a query, asks Bilibili's public API,
and returns results in the same shape the desktop app uses. It does **not**
download files, does **not** do YouTube, and has no accounts or persistence.

- How the web app uses it: it is one optional input in the phone app's
  **Settings → Cloud Search**. When set, online search tries the cloud first
  and falls back to your computer's LAN server automatically.
- What it never does: it stores nothing, logs nothing, and answers every
  request the same way a public read-only API does.

> **Why Bilibili-only?** The cloud intentionally skips YouTube. YouTube search
> needs `yt-dlp` + `ffmpeg` and heavy `bandwidth/CPU` (both download+transcode),
> which the free tier can't sustain — and proxying YouTube audio for many users
> is legally/ethically risky. The desktop LAN server still provides YouTube.

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

The audio endpoint `/online/audio?id=BVxxxxx` streams the video's audio
through the proxy so the phone's browser can play it despite Bilibili's
cross-origin restrictions. It is a best-effort pass-through (no transcode), so
some very short clips may not have usable audio — that's expected and non-fatal.

---

## Deploy to Render (free)

1. **Push this repo to GitHub** if you haven't already.
2. Go to **[https://dashboard.render.com/select-repo](https://dashboard.render.com/select-repo)**
   and choose this repository.
3. Render detects **`cloud/render.yaml`** and pre-fills a Web Service
   (Docker runtime, Free plan). Give it a name (e.g. `needmusic-cloud`).
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

| Var    | Default | Meaning                                   |
|--------|---------|-------------------------------------------|
| `PORT` | `3001`  | Port Render assigns. Your Dockerfile + `render.yaml` already set it. |

No other config is needed.
