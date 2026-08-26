# NeedMusic cloud proxy — runs on Render's free tier.
# Minimal: just the Node runtime. The server uses only Node built-ins
# (http, url, crypto), so there are no runtime dependencies to install.
FROM node:20-slim

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
