# Video Worker — standalone MP4 render service.
#
# Runs the same recorder engine as the bot's self-hosted path, but as its own
# Railway service so heavy Chromium + FFmpeg renders never compete with the
# bot's memory. The bot points RECORD_API_URL at this service's /api/record.
#
# node:20-bookworm-slim (NOT bullseye): playwright-core 1.62.1 dropped Debian
# 11 support ("Playwright does not support chromium on debian11-x64"), and the
# old bullseye base here shipped a chromium that never launched.
FROM node:20-bookworm-slim

# System ffmpeg + the shared-library set chromium needs for headless launches
# (mirrors bot/Dockerfile, which ships working renders). Never install the
# distro `chromium` apt package — it is a snap stub and breaks headless
# launches in containers; the Playwright-managed browser is installed below.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-noto \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No package-lock.json in this repo — `npm install` (not `npm ci`).
# NOTE: NODE_ENV must NOT be production here, or npm skips devDependencies and
# the `tsc` build below fails.
COPY package.json ./
RUN npm install

COPY . .

# Download the chromium revision pinned by the LOCAL playwright-core (1.62.1)
# into $HOME/.cache/ms-playwright — exactly where recorderDiagnostics() looks
# for it, and the revision launch() finds with no PLAYWRIGHT_CHROMIUM_PATH.
# `playwright-core` (not `playwright`) is the installed package, so the install
# command must be `npx playwright-core install chromium`.
RUN npx playwright-core install chromium

RUN npm run build

# The runtime (`node dist/server.js`) needs no build toolchain — shrink it.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

CMD ["npm", "start"]
