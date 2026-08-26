# NeedMusic cloud proxy — runs on Render's free tier.
# Minimal: install deps, then start the server with Node's TS strip-types.
FROM node:20-slim

WORKDIR /app

# Install only the cloud service (it has no runtime deps beyond Node built-ins).
COPY cloud/package.json cloud/package-lock.json* ./
RUN npm install --omit=dev

COPY cloud/index.ts .
COPY cloud/tsconfig.json ./

ENV PORT=3001
EXPOSE 3001

CMD ["npx", "node", "--experimental-strip-types", "index.ts"]
