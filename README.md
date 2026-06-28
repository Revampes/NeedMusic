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

**v1.0** — Initial stable release.

| Component | Version |
|-----------|---------|
| NeedMusic App | `1.0` |
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

### 🌐 Online Music Search (Bilibili)
- Search for music directly from **Bilibili**
- **Stream** — one-click play without saving
- **Save to library** — download permanently into your music folder

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
```

The Tauri build outputs the installer to `src-tauri/target/release/bundle/`.  
The web build outputs static files to `dist-web/` — deploy these to any static host (Netlify, Vercel, Cloudflare Pages, etc.).

---

## 🔒 User Privacy

NeedMusic is built with privacy as a core principle:

- **No telemetry.** NeedMusic does **not** collect, report, or send any usage data, analytics, or crash reports anywhere. There is no backend server operated by NeedMusic.
- **No accounts.** There is no login, no user registration, and no cloud sync. Everything lives on your machine.
- **Local-first storage.** Your music library metadata, playlists, favorites, and settings are stored exclusively in a **local SQLite database** (`needmusic.db`) on your computer. In the web build, data is stored in your browser's `localStorage`.
- **Online search transparency.** When you use the Bilibili search feature, search queries are sent directly from your machine to `api.bilibili.com`. NeedMusic does not proxy, intercept, or log these requests.
- **Discord Rich Presence.** When enabled, track information (title, artist, album) is sent to your **local Discord client** via named pipe IPC — it never leaves your machine. Disable it anytime from Settings.
- **No network requests at startup.** The app makes zero outbound connections unless you explicitly use the online search feature or enable Discord Rich Presence.

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://github.com/Revampes">Revampes</a> · Built with <a href="https://tauri.app">Tauri</a>, <a href="https://react.dev">React</a> &amp; <a href="https://www.rust-lang.org">Rust</a></sub>
</p> 
