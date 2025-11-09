import path from 'node:path';
import { promises as dns } from 'node:dns';
import fs from 'fs-extra';
import ytpl from 'ytpl';
import { SongTask } from './types.js';

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_SONGS_FILE = path.resolve(process.cwd(), 'songs.txt');
export const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');
export const ERRORS_LOG = path.resolve(process.cwd(), 'errors.log');

/**
 * Ensures the downloads directory exists so audio files have a target path.
 */
export const ensureDownloadsDir = async (): Promise<void> => {
  await fs.ensureDir(DOWNLOADS_DIR);
};

/**
 * Reads song titles from the provided list file and returns clean entries only.
 */
export const readSongList = async (filePath: string = DEFAULT_SONGS_FILE): Promise<string[]> => {
  const exists = await fs.pathExists(filePath);
  if (!exists) {
    return [];
  }
  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  return lines
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0 && !line.startsWith('#'));
};

/**
 * Generates repeatable task descriptors for every song title that needs searching.
 */
export const buildSongTasks = (entries: string[]): SongTask[] =>
  entries.map((entry, index) =>
    isYoutubeUrl(entry)
      ? { id: index + 1, mode: 'direct', query: entry, url: entry }
      : { id: index + 1, mode: 'search', query: entry },
  );

/**
 * Builds playlist download tasks for every video contained in the provided YouTube playlist URL.
 */
export const buildPlaylistTasks = async (playlistUrl: string): Promise<SongTask[]> => {
  const playlist = await ytpl(playlistUrl, { limit: Infinity });

  return playlist.items
    .filter((item) => Boolean(item.url))
    .map((item, index) => {
      const itemTitle = item.title ?? `Playlist item ${index + 1}`;
      return {
        id: index + 1,
        mode: 'playlist',
        query: `${playlist.title} :: ${itemTitle}`,
        url: item.shortUrl ?? item.url,
        displayTitle: itemTitle,
        playlistTitle: playlist.title,
      } satisfies SongTask;
    });
};

/**
 * Sanitizes possible file names so they are safe to write to the filesystem.
 */
export const sanitizeFileName = (value: string): string =>
  value.replace(/[\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/u, '');

/**
 * Returns an absolute mp3 file path for a given base name.
 */
export const resolveOutputPath = (baseName: string, baseDir: string = DOWNLOADS_DIR): string =>
  path.resolve(baseDir, `${sanitizeFileName(baseName)}.mp3`);

/**
 * Checks whether the given mp3 file has already been downloaded.
 */
export const isAlreadyDownloaded = async (filePath: string): Promise<boolean> =>
  fs.pathExists(filePath);

/**
 * Appends error information to a persistent log so the user can review failures.
 */
export const logFailure = async (message: string): Promise<void> => {
  const timestamp = new Date().toISOString();
  await fs.appendFile(ERRORS_LOG, `[${timestamp}] ${message}\n`);
};

/**
 * Ensures a dedicated folder exists for playlist downloads and returns its path.
 */
export const createPlaylistDirectory = async (playlistName: string): Promise<string> => {
  const folderName = sanitizeFileName(playlistName) || `playlist-${Date.now()}`;
  const playlistDir = path.resolve(DOWNLOADS_DIR, folderName);
  await fs.ensureDir(playlistDir);
  return playlistDir;
};

/**
 * Detects whether a given string looks like a direct YouTube URL.
 */
export const isYoutubeUrl = (input: string): boolean => {
  try {
    const parsed = new URL(input);
    return /(^|\.)youtube\.com$/.test(parsed.hostname) || parsed.hostname === 'youtu.be';
  } catch {
    return false;
  }
};

/**
 * Detects whether a given string refers to a YouTube playlist (via list parameter or playlist path).
 */
export const isYoutubePlaylistUrl = (input: string): boolean => {
  try {
    const parsed = new URL(input);
    if (!isYoutubeUrl(input)) {
      return false;
    }
    if (parsed.searchParams.has('list')) {
      return true;
    }
    return parsed.pathname.includes('/playlist');
  } catch {
    return false;
  }
};

/**
 * Quickly probes DNS to help surface connectivity issues before downloads run.
 */
export const verifyInternet = async (): Promise<void> => {
  await dns.lookup('youtube.com');
};

/**
 * Removes temporary player script files that ytdl-core may leave behind.
 */
export const cleanupPlayerScripts = async (): Promise<void> => {
  try {
    const cwd = process.cwd();
    const entries = await fs.readdir(cwd);
    const targets = entries.filter((name) => /player-script\.js$/u.test(name));
    if (targets.length === 0) {
      return;
    }
    await Promise.all(
      targets.map(async (name) => {
        const filePath = path.resolve(cwd, name);
        try {
          await fs.remove(filePath);
        } catch (error) {
          await logFailure(`Cleanup failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  } catch (error) {
    await logFailure(`Cleanup scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
