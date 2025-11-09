# YouTube MP3 Downloader

A TypeScript CLI for downloading YouTube videos as MP3 files. Supports batch downloads from a file, single video downloads by URL, and entire playlists.

## Overview

- **List Mode**: Batch download multiple songs from `songs.txt` (search by title or direct URL)
- **Direct Mode**: Download a single video by URL
- **Playlist Mode**: Download all videos from a YouTube playlist
- Parallel downloads with configurable concurrency

## Prerequisites

- Node.js v18 or later

## Installation

```bash
git clone https://github.com/TsuKpa/download-yt-mp3.git
cd download-yt-mp3
npm install
```

## Usage

### Interactive Mode (No Arguments)

```bash
npm start
```

Choose from a menu:
```
Select download mode:
  1. Download from songs.txt
  2. Direct by YouTube URL
  3. Download entire playlist
Enter choice (1-3): 
```

### List Mode

Download from `songs.txt`:

```bash
npm start
```

With a custom file and concurrency:

```bash
npm start -- --file my-songs.txt --concurrency 5
```

Format of `songs.txt`:
```
Song Title 1
Song Title 2
https://www.youtube.com/watch?v=...
Song Title 3
# Comments are ignored
```

### Direct Mode

Download a single video:

```bash
npm start -- https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

Or with a flag:

```bash
npm start -- --url https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### Playlist Mode

Download an entire playlist:

```bash
npm start -- --playlist https://www.youtube.com/playlist?list=PLxxx
```

You'll be prompted for:
- Folder name (for organization)
- Numeric prefix preference (e.g., `1. Song.mp3`, `2. Song.mp3`)
- Starting number (if prefix is enabled)

### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--file <path>` | `-f` | Path to songs list (default: `songs.txt`) |
| `--concurrency <n>` | `-c` | Max parallel downloads (default: `3`) |
| `--url <url>` | | Direct video URL |
| `--playlist <url>` | | Playlist URL |
| `--help` | `-h` | Show help message |

### Example Commands

```bash
# Help
npm start -- --help

# List with 10 concurrent downloads
npm start -- -f songs.txt -c 10

# Direct download
npm start -- --url "https://www.youtube.com/watch?v=..."

# Set concurrency via environment
DOWNLOAD_CONCURRENCY=10 npm start
```

## Output

- MP3 files: `downloads/`
- Error log: `errors.log`

Each download shows real-time progress:

```
▓▓▓▓▓▓░░░░ 60% | Song Title Here
▓▓▓▓▓▓▓▓▓▓ 100% | Another Song
█░░░░░░░░░ 5% | Third Song
```

Summary at the end:
```
Download summary
┌───────┬────────────┬───────────┬─────────┬──────┐
│ ID    │ Query      │ Status    │ Reason  │ File │
├───────┼────────────┼───────────┼─────────┼──────┤
│ 1     │ Song 1     │ completed │         │ ...  │
│ 2     │ Song 2     │ skipped   │ Already │ ...  │
│ 3     │ Song 3     │ failed    │ Error   │      │
└───────┴────────────┴───────────┴─────────┴──────┘
Totals => processed: 3, completed: 1, skipped: 1, failed: 1
```

---

**License**: MIT © [TsuKpa](https://github.com/TsuKpa)
