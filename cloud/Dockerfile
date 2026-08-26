# NeedMusic cloud proxy — runs on Render's free tier.
# The server uses only Node built-ins (http, url, crypto, child_process) plus
# ffmpeg (installed below) to transcode Bilibili's fMP4 DASH audio into a plain
# MP3 that iOS Safari can actually play (the desktop does the same conversion).
FROM node:20-slim

# ffmpeg: transcodes Bilibili DASH audio → MP3 (browser-playable, incl. iOS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

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
