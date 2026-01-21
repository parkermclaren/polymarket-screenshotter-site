# Polymarket Screenshotter (Standalone)

This is a standalone Next.js app that captures clean 7:8 screenshots of Polymarket market pages.

## Run locally

```bash
npm install
npm run dev
```

Then open:
- `/` (redirects to `/polymarket-screenshotter`)

## API

- `GET /api/polymarket-screenshot?url=<polymarket-url>&timeRange=1d&return=json`
- `GET /api/polymarket-screenshot?url=<polymarket-url>&timeRange=1d` (returns PNG)

## Notes

- If deploying to Railway, you may want to set `PUPPETEER_EXECUTABLE_PATH` to the system chromium/chrome path.
