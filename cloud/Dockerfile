# NeedMusic cloud proxy — runs on Render's free tier.
# The server uses only Node built-ins (http, url, crypto, child_process) plus:
#   ffmpeg  → transcodes Bilibili DASH / YouTube audio into a plain MP3 that
#             iOS Safari can actually play (the desktop does the same).
#   yt-dlp  → YouTube search + audio extraction (Python CLI).
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  # yt-dlp for YouTube search/audio; --break-system-packages is needed on
  # Debian bookworm+ (PEP 668). -U keeps the player-client impersonation
  # fixes that dodge YouTube's cloud-IP bot checks.
  && pip3 install --break-system-packages --no-cache-dir -U yt-dlp \
  && yt-dlp --version

WORKDIR /app

# Copy the cloud service in so `docker run` works standalone.
COPY cloud/ ./cloud/

ENV PORT=3001
EXPOSE 3001

# Default command (used when running the image directly, e.g. `docker run`).
# On Render, the "Start Command" at deploy time takes precedence and should be:
#     node --experimental-strip-types cloud/index.ts
# (Render executes it from the repo root /opt/render/project/src, so the
#  `cloud/` prefix is required.)
CMD ["node", "--experimental-strip-types", "/app/cloud/index.ts"]
