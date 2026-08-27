# Video Worker Template

This is a standalone Express server that handles MP4 rendering for meme-loop-engine using Playwright and FFmpeg.

Every finished render is published to **here.now** — the bot receives the durable `result.url` (a here.now player page) and hands users a shareable link instead of a transient Railway `/download` URL. The MP4 is also directly downloadable at `<page-url>/ralph.mp4`.

## 1-Click Deploy to Railway

Deploy link: `https://railway.com/new/template?template=https://github.com/davenamovich/plunder-riffle-video-worker-template&referralCode=XO8ClD`

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `WORKER_SECRET` | yes | The secret the bot sends as `x-operator-secret` on every render request. Set it to the same value you enter in the bot with `/railway`. |
| `HERENOW_API_KEY` | no | here.now API key for **authenticated** publishes (pages stay alive). When unset (or no key forwarded per-job), renders publish anonymously and expire in ~24h. |
| `PORT` | no | Listen port (default `3000`). Railway sets this automatically. |

## Endpoints

- `POST /api/record` — start a render. Accepts the bot's payload (`url`, `autoDuration`, `durationMs`, `viewport`, `aspectRatio`, `songUrl`, `herenowApiKey`, …).
- `GET /api/record/:id` — job status; when `done` the body carries `result.url` (here.now page) and `result.mediaUrl` (direct MP4).
- `GET /api/record/:id/download` — the finished MP4 bytes (transient; the durable copy lives on here.now).
- `DELETE /api/record/:id` — delete a job and its files.
- `GET /health` — up + ffmpeg/chromium diagnostics.

## Local Development

```bash
npm install
npm start
```

This starts the worker on port 3000. `WORKER_SECRET` is optional locally (skips auth when unset); set `HERENOW_API_KEY` to publish authenticated.
