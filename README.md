<p align="center">
  <img src="src-tauri/icons/icon.ico" alt="NeedMusic" width="96" />
</p>

<h1 align="center">NeedMusic</h1>

<p align="center">
  <strong>A high-performance, locally installed desktop music player — with a companion web app.</strong>
</p>

<p align="center">
  <a href="#-install-now"><strong>Install Now</strong></a> &nbsp;·&nbsp;
  <a href="#-current-version">Version</a> &nbsp;·&nbsp;
  <a href="#-core-functions">Core Functions</a> &nbsp;·&nbsp;
  <a href="#-local-deploy">Local Deploy</a> &nbsp;·&nbsp;
  <a href="#-user-privacy">Privacy</a>
</p>

---

## 🚀 Install Now

Get the latest pre-built installer from the **[GitHub Releases](https://github.com/Revampes/NeedMusic/releases)** page.

| Platform | Package | Notes |
|----------|---------|-------|
| **Windows** | `NeedMusic_Setup.exe` | NSIS installer — installs to `%LOCALAPPDATA%\NeedMusic` |
| **Web (PWA)** | Hosted at your deploy target | See [Local Deploy](#-local-deploy) to self-host |

> **System Requirements (Windows):** Windows 10 or later. WebView2 is required (included in Windows 10+ by default).

After installing, point NeedMusic at your local music folder and it will automatically scan and catalog your entire library.

---

## 📦 Current Version

**v3.0** — LAN phone companion, dynamic-island style sync, one-click updates.

| Component | Version |
|-----------|---------|
| NeedMusic App | `3.0` |
| Tauri Runtime | `2.x` |
| React UI | `18.x` |
| TypeScript | `5.5` |

---

## 🎵 Core Functions

### 🗂️ Local Music Library
- **Recursive scanning** of directories for audio files (MP3, FLAC, M4A, AAC, OGG, Opus, WAV, WMA, AIFF)
- **Rich metadata parsing** — ID3 tags, Vorbis comments, MP4 atoms, FLAC STREAMINFO
- **Album artwork extraction** from embedded covers
- **Automatic grouping** by Album and Artist
- **Powerful search & filtering** across your entire library

### ▶️ Playback Engine
- Full playback controls — play, pause, resume, stop, next, previous, seek
- **Queue management** — enqueue tracks/albums/playlists, reorder, remove, clear
- **Repeat modes** — Off, Track, Playlist
- **Shuffle** support
- **Variable playback speed** — 0.5× to 2×
- **Volume control** with WASAPI integration (appears as "NeedMusic" in Windows Volume Mixer)

### 📋 Playlists & Favorites
- Create, rename, delete custom playlists
- **Favorites** — heart a track and it auto-syncs to a `★ Favorites` playlist
- Drag-and-drop reordering within playlists

### 🌐 Online Music Search (Bilibili + YouTube)
- Search for music directly from **Bilibili** and **YouTube**
- **Simultaneous search** — results from both platforms appear in separate sections
- **Stream** — one-click play without saving (temp download, auto-cleaned)
- **Save to library** — download permanently into your music folder
- **Cloud search (optional)** — deploy the tiny `cloud/` proxy to Render's free tier and
  phones can run Bilibili search **without a computer**, with automatic fallback to LAN sync
- YouTube search is **opt-in** via Settings (requires [yt-dlp](https://github.com/yt-dlp/yt-dlp) — auto-installed on first use)
- YouTube downloads are **audio-only** (no video) using yt-dlp
- ⚠️ YouTube downloads are provided for personal use — enable at your own risk

### 🎮 Discord Rich Presence
- Shows your current track on your Discord profile
- Displays track title, artist, album, and playback progress
- Auto-reconnect on connection loss

### 🏝️ Dynamic Island
- A **separate, always-on-top floating mini-player** window
- Shows current track, artwork, and basic controls
- Inspired by Apple's Dynamic Island — compact and glanceable

### 🎨 Themes & Customization
- **Dark** theme
- **Light** theme
- **Glass** theme (with Windows Mica blur)
- **Custom** — set your own background image, gradient, blur intensity, and opacity

### 🖥️ System Integration
- **System tray** — minimize to tray, quick play/pause/skip from tray menu
- **Global media shortcuts** — media keys work even when the app is in the background
- **Auto-start** — optionally launch at Windows boot
- **Gaming mode** — automatically lowers volume to 25% when you tab away into a game, restores on return

---

## 💻 Local Deploy

Build and run NeedMusic from source.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | ≥18 | [nodejs.org](https://nodejs.org) |
| **Rust** | ≥1.70 | [rustup.rs](https://rustup.rs) |
| **Git** | any | [git-scm.com](https://git-scm.com) |
| **yt-dlp** | any | Auto-installed on first YouTube search, or `pip install yt-dlp` |

> On Windows, make sure the **MSVC build tools** are installed (included with [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) or by running `rustup default stable-msvc`).

### Clone & Install

```bash
# Clone the repository
git clone https://github.com/Revampes/NeedMusic.git
cd NeedMusic

# Install frontend dependencies
npm install
```

### Run in Development Mode

```bash
# Desktop app (Tauri + Vite dev server)
npm run tauri dev
```

```bash
# Web app only (browser dev server on port 3000)
npm run dev:web
```

### Build for Production

```bash
# Desktop installer (.exe)
npm run tauri build

# Web app (outputs to dist-web/)
npm run build:web

# Build the web app AND publish it to the gh-pages branch (GitHub Pages)
npm run deploy:web
```

The Tauri build outputs the installer to `src-tauri/target/release/bundle/`.  
The web build outputs static files to `dist-web/` — deploy these to any static host (Netlify, Vercel, Cloudflare Pages, etc.).

> **`npm run deploy:web`** is the one-command flow for GitHub Pages: it runs the web build, then pushes `dist-web/` to the `gh-pages` branch (via a git worktree, reusing `../NeedMusic-pages` if you have one). The branch only contains the compiled site (`index.html`, `assets/`, `.nojekyll`) — never the source. Use `npm run deploy:web -- --dry-run` to preview the commit without pushing.

### 📱 Phone Companion (LAN Sync)

Stream your library to your phone over Wi-Fi — no cloud, no accounts:

1. In the desktop app open **Settings → LAN Sync → Start Server**.
2. Open the shown address (e.g. `http://192.168.1.10:17963/?token=…`) in Safari/Chrome on your phone.
3. The web player loads **directly from your computer** (the LAN server serves the built web app) and syncs your library automatically — the token in the address keeps the API private.

Online search on the phone is proxied through the desktop, so Bilibili/YouTube search works exactly like on desktop. The phone only stores what it plays; nothing is uploaded anywhere.

### ☁️ Cloud Search (optional) — search without your computer

Want phone online-search even when the desktop (and LAN) is offline? Deploy the
tiny **`cloud/`** proxy to [Render's free tier](https://render.com) in ~5 minutes:

1. `cloud/` contains a single self-contained Node/TypeScript server (`index.ts`)
   plus `Dockerfile` and `render.yaml`. Point Render at this repo and it deploys
   automatically.
2. If Render asks for a **Start Command**, paste `node --experimental-strip-types cloud/index.ts`
   (the `cloud/` prefix matters — Render runs this from the repo root, where the
   file is `cloud/index.ts`). Render then gives you a URL like
   `https://needmusic-cloud.onrender.com`.
3. In the phone web app open **Settings → Cloud Search**, paste that URL, tap
   **Enable**. Online search now tries the **cloud first**, and falls back to
   your computer's **LAN server** whenever the cloud is unreachable.

The cloud service is **Bilibili-only** and lightweight by design — see
[`cloud/README.md`](cloud/README.md). It serves search results and, when you
tap **Save**, downloads + transcodes the audio to MP3 (via ffmpeg) so the track
plays on any phone, including iOS Safari — mirroring what the desktop's "Save"
does. YouTube is intentionally not on the cloud (it needs `yt-dlp` and heavy
bandwidth); YouTube search/download still works on the desktop/LAN.

> **Free-tier note:** Render's free service sleeps after ~15 min idle; the first
> search after that takes ~15–50s to cold-start, then runs normally. The cloud is
> public (no auth) — anyone with your URL can issue searches, so keep it personal.

---

## 🔒 User Privacy

NeedMusic is built with privacy as a core principle:

- **No telemetry.** NeedMusic does **not** collect, report, or send any usage data, analytics, or crash reports anywhere. There is no first-party backend server operated by NeedMusic.
- **No accounts.** There is no login, no user registration, and no cloud sync. Everything lives on your machine.
- **Local-first storage.** Your music library metadata, playlists, favorites, and settings are stored exclusively in a **local SQLite database** (`needmusic.db`) on your computer. In the web build, data is stored in your browser's `localStorage`.
- **Online search transparency.** When you use the Bilibili search feature, search queries are sent directly from your machine to `api.bilibili.com`. NeedMusic does not proxy, intercept, or log these requests. *(If you **optionally** enable Cloud Search in the web app, queries first go to the `cloud/` proxy you choose to host on Render, which then calls Bilibili — only search text is passed, and the proxy logs nothing.)*
- **Discord Rich Presence.** When enabled, track information (title, artist, album) is sent to your **local Discord client** via named pipe IPC — it never leaves your machine. Disable it anytime from Settings.
- **No network requests at startup.** The app makes zero outbound connections unless you explicitly use the online search feature or enable Discord Rich Presence.

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://github.com/Revampes">Revampes</a> · Built with <a href="https://tauri.app">Tauri</a>, <a href="https://react.dev">React</a> &amp; <a href="https://www.rust-lang.org">Rust</a></sub>
</p> 
<p align="center">
  <sub>Star this repo to support the project! Thank You!</sub>
</p>
