# TypeScript YouTube MP3 Downloader

A TypeScript CLI that downloads YouTube videos as MP3 files in either list mode (batch) or direct mode (single URL).

## Prerequisites
- Node.js v18 or later
- `ffmpeg` is bundled via `ffmpeg-static`; no system install needed

## Installation
```bash
npm install
```

## Usage
### List Mode
Process every entry in `songs.txt` (default concurrency 3):
```bash
npm start
```

Provide a custom list and custom concurrency:
```bash
npm start -- --file ./my-songs.txt --concurrency 5
```

### Direct Mode
Download a single video by URL:
```bash
npm start -- https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

Or with an explicit flag:
```bash
npm start -- --url https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

If no URL is provided in direct mode you will be prompted to paste one.

## Features
- Functional, modular TypeScript code
- Controlled parallel downloads using `p-limit`
- Individual progress bars with `cli-progress`
- Automatic MP3 conversion via `fluent-ffmpeg` and `ffmpeg-static`
- Skips already-downloaded tracks
- Resilient fallback to `yt-dlp` when YouTube signature changes occur (binary auto-downloaded on first run)
- Detailed summary and persistent `errors.log`

## Output
All MP3 files are saved in the `downloads/` folder. Errors are logged to `errors.log` for later review.
