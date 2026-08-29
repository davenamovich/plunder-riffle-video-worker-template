# Video Worker Template

This is a standalone Express server that handles MP4 rendering for meme-loop-engine using Playwright and FFmpeg.

## 1-Click Deploy to Railway

To create a 1-click deploy link for this template:

1. Push this folder (`packages/video-worker`) to a new, public GitHub repository (e.g., `yourname/video-worker-template`).
2. Construct the Railway template URL using the following format:
   `https://railway.com/new/template?template=https://github.com/davenamovich/plunder-riffle-video-worker-1&referralCode=XO8ClD`

Users clicking the link will instantly deploy this worker to their own Railway account, and your referral code (`XO8ClD`) will be automatically applied!

## Local Development

```bash
npm install
npm start
```

This starts the worker on port 3000. It exposes the following endpoints:

- `POST /api/record`
- `GET /api/record/:id`
- `DELETE /api/record/:id`
- `GET /health`
