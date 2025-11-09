import path from 'node:path';
import process from 'node:process';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import ytdl from '@distube/ytdl-core';
import { findFirstVideo } from './search.js';
import { downloadToMp3 } from './download.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SONGS_FILE,
  DOWNLOADS_DIR,
  buildSongTasks,
  buildPlaylistTasks,
  cleanupPlayerScripts,
  createPlaylistDirectory,
  ensureDownloadsDir,
  getMaxNumberPrefix,
  getMaxNumberPrefixInDownloads,
  isAlreadyDownloaded,
  isYoutubeUrl,
  isYoutubePlaylistUrl,
  logFailure,
  logSuccess,
  logPlaylistSummary,
  readSongList,
  resolveOutputPath,
  sanitizeFileName,
  verifyInternet,
} from './utils.js';
import { SongTask, TaskResult } from './types.js';

interface CliConfig {
  readonly mode: 'search' | 'direct' | 'playlist';
  readonly songsFile?: string;
  readonly url?: string;
  readonly playlistUrl?: string;
  readonly concurrency: number;
}

/**
 * Parses incoming CLI arguments and resolves the effective execution configuration.
 */
const parseArgs = (argv: string[]): CliConfig => {
  let concurrency = Number.parseInt(process.env.DOWNLOAD_CONCURRENCY ?? '', 10);
  if (Number.isNaN(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }

  let songsFile: string | undefined;
  let url: string | undefined;
  let playlistUrl: string | undefined;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      case '--file':
      case '-f': {
        const next = args[i + 1];
        if (next) {
          songsFile = path.resolve(process.cwd(), next);
          i += 1;
        }
        break;
      }
      case '--url': {
        const next = args[i + 1];
        if (next) {
          url = next;
          i += 1;
        }
        break;
      }
      case '--playlist': {
        const next = args[i + 1];
        if (next) {
          playlistUrl = next;
          i += 1;
        }
        break;
      }
      case '--concurrency':
      case '-c': {
        const next = args[i + 1];
        if (next) {
          const parsed = Number.parseInt(next, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            concurrency = parsed;
          }
          i += 1;
        }
        break;
      }
      default: {
        if (!playlistUrl && isYoutubePlaylistUrl(arg)) {
          playlistUrl = arg;
          break;
        }
        if (!url && isYoutubeUrl(arg)) {
          url = arg;
        }
        if (arg.startsWith('--concurrency=')) {
          const parsed = Number.parseInt(arg.split('=')[1] ?? '', 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            concurrency = parsed;
          }
        }
        break;
      }
    }
  }

  if (playlistUrl) {
    return { mode: 'playlist', playlistUrl, concurrency };
  }

  if (url) {
    return { mode: 'direct', url, concurrency };
  }

  return { mode: 'search', songsFile, concurrency };
};

/**
 * Displays a concise help menu describing supported CLI options.
 */
const printHelp = (): void => {
  console.log(`\nYouTube MP3 Downloader\n\n`);
  console.log('Usage:');
  console.log('  tsx src/index.ts                 # Process songs.txt in list mode');
  console.log('  tsx src/index.ts --file custom.txt # Use a custom song list');
  console.log('  tsx src/index.ts <YouTube URL>     # Direct mode by positional URL');
  console.log('  tsx src/index.ts --url <URL>       # Direct mode via flag');
  console.log('  tsx src/index.ts --playlist <URL>  # Download every video in a playlist');
  console.log('\nOptions:');
  console.log('  -f, --file <path>        Path to songs list file');
  console.log('  -c, --concurrency <n>    Maximum parallel downloads (default 3)');
  console.log('      --concurrency=n      Alternative concurrency syntax');
  console.log('      --playlist <url>     Download from a YouTube playlist');
  console.log('  -h, --help               Show this help message');
};

/**
 * Prompts the user for a YouTube URL when direct mode arguments are missing.
 */
const promptForUrl = async (): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Enter a YouTube video URL: ');
    return answer.trim();
  } finally {
    rl.close();
  }
};

/**
 * Prompts the user for a YouTube playlist URL when playlist mode is selected.
 */
const promptForPlaylistUrl = async (): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = await rl.question('Enter a YouTube playlist URL: ');
      const normalized = answer.trim();
      if (normalized && isYoutubePlaylistUrl(normalized)) {
        return normalized;
      }
      console.log('Please provide a valid YouTube playlist URL.');
    }
  } finally {
    rl.close();
  }
};

/**
 * Prompt the user for a playlist folder name, using the detected title as a default suggestion.
 */
const promptForPlaylistFolderName = async (suggestedName: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const promptMessage = `Enter a folder name for the playlist [${suggestedName}]: `;
    const answer = await rl.question(promptMessage);
    const normalized = answer.trim();
    return normalized.length > 0 ? normalized : suggestedName;
  } finally {
    rl.close();
  }
};

/**
 * Determines whether the user wants to apply numeric prefixes to playlist downloads.
 */
const promptForPrefixChoice = async (): Promise<boolean> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = await rl.question('Do you want to add a numeric prefix to each file? (y/n): ');
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'n' || normalized === 'no') {
        return false;
      }
      console.log('Please respond with y(es) or n(o).');
    }
  } finally {
    rl.close();
  }
};

/**
 * Prompts for the starting number to use when applying numeric prefixes.
 * If a default value is provided, the user can press Enter to accept it.
 */
const promptForStartingNumber = async (defaultValue?: number): Promise<number> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const promptText = defaultValue !== undefined 
        ? `Please enter the starting number [${defaultValue}]: `
        : 'Please enter the starting number: ';
      const answer = await rl.question(promptText);
      const trimmed = answer.trim();
      
      // If user just presses Enter and we have a default, use it
      if (trimmed === '' && defaultValue !== undefined) {
        return defaultValue;
      }
      
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
      console.log('Please provide a non-negative whole number.');
    }
  } finally {
    rl.close();
  }
};

/**
 * Presents an interactive menu so the user can choose between list and direct modes.
 */
const promptForMode = async (): Promise<'search' | 'direct' | 'playlist'> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      console.log('\nSelect download mode:');
      console.log('  1. Download from songs.txt');
      console.log('  2. Direct by YouTube URL');
      console.log('  3. Download entire playlist');
      const answer = await rl.question('Enter choice (1-3): ');
      const normalized = answer.trim();
      if (normalized === '1') {
        return 'search';
      }
      if (normalized === '2') {
        return 'direct';
      }
      if (normalized === '3') {
        return 'playlist';
      }
      console.log('Invalid selection, please enter 1, 2, or 3.');
    }
  } finally {
    rl.close();
  }
};

/**
 * Asks whether the user wants to launch another download session.
 */
const promptContinue = async (): Promise<boolean> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = await rl.question('\nRun another session? (y/n): ');
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'n' || normalized === 'no' || normalized === 'q' || normalized === 'quit') {
        return false;
      }
      console.log('Please respond with y(es) or n(o).');
    }
  } finally {
    rl.close();
  }
};

/**
 * Truncates long titles so progress bars remain readable in narrower terminals.
 */
const truncateTitle = (value: string, maxLength = 42): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

/**
 * Coordinates download work for a single song task, including progress updates.
 */
type ProgressBar = ReturnType<cliProgress.MultiBar['create']>;

const runTask = async (
  task: SongTask,
  bars: cliProgress.MultiBar,
): Promise<TaskResult> => {
  let bar: ProgressBar | undefined;
  let displayTitle = task.displayTitle ?? task.query;
  let videoUrl = task.url ?? '';
  const targetDir = task.outputDir ?? DOWNLOADS_DIR;

  try {
    if (task.mode === 'direct' || task.mode === 'playlist') {
      videoUrl = task.url ?? task.query;
      if (!videoUrl) {
        throw new Error('Missing video URL');
      }
      if (!task.displayTitle) {
        const info = await ytdl.getBasicInfo(videoUrl);
        displayTitle = info.videoDetails.title ?? task.query;
      }
    } else {
      const video = await findFirstVideo(task.query);
      if (!video) {
        const reason = 'No search results';
        await logFailure(`${task.query} :: ${reason}`);
        return { id: task.id, query: task.query, url: '', status: 'failed', reason };
      }
      videoUrl = video.url;
      displayTitle = video.title;
    }

    const numberPrefix = typeof task.sequenceNumber === 'number' ? `${task.sequenceNumber}. ` : '';
    const titledDisplay = `${numberPrefix}${displayTitle}`.trim();
    const safeTitle = sanitizeFileName(titledDisplay) || `youtube-audio-${task.id}`;
    const outputPath = resolveOutputPath(safeTitle, targetDir);

    if (await isAlreadyDownloaded(outputPath)) {
      return {
        id: task.id,
        query: task.query,
        url: videoUrl,
        status: 'skipped',
        reason: 'Already downloaded',
        filePath: outputPath,
      };
    }

    bar = bars.create(100, 0, { title: truncateTitle(titledDisplay) });

    const finalPath = await downloadToMp3({
      url: videoUrl,
      title: safeTitle,
      outputDir: targetDir,
      onProgress: (percent: number, _downloaded: number, _total: number) => {
        const clamped = Math.min(100, Math.max(0, Math.floor(percent * 100)));
        bar?.update(clamped, { title: truncateTitle(titledDisplay) });
      },
    });

    bar.update(100, { title: truncateTitle(titledDisplay) });

    // Log success with playlist info if available
    await logSuccess(
      finalPath,
      task.mode === 'playlist' ? task.playlistTitle : undefined,
      task.mode === 'playlist' ? targetDir : undefined,
    );

    return {
      id: task.id,
      query: task.query,
      url: videoUrl,
      status: 'completed',
      filePath: finalPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logFailure(`${task.query} :: ${message}`);
    return {
      id: task.id,
      query: task.query,
      url: videoUrl || task.url || '',
      status: 'failed',
      reason: message,
    };
  } finally {
    if (bar) {
      bar.stop();
      bars.remove(bar);
    }
  }
};

/**
 * Summarizes overall processing results at the end of the execution.
 */
const printSummary = (results: TaskResult[]): void => {
  const counts = results.reduce(
    (acc, result) => {
      acc.total += 1;
      acc[result.status] += 1;
      return acc;
    },
    { total: 0, completed: 0, skipped: 0, failed: 0 } as Record<'total' | 'completed' | 'skipped' | 'failed', number>,
  );

  console.log('\nDownload summary');
  console.table(
    results.map((result) => ({
      ID: result.id,
      Query: result.query,
      Status: result.status,
      Reason: result.reason ?? '',
      File: result.filePath ?? '',
    })),
  );
  console.log(
    `Totals => processed: ${counts.total}, completed: ${counts.completed}, skipped: ${counts.skipped}, failed: ${counts.failed}`,
  );
};

/**
 * Runs a download session for the resolved configuration.
 */
const runDownloadSession = async (config: CliConfig): Promise<void> => {
  try {
    await verifyInternet();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Connectivity check failed: ${message}`);
  }

  await ensureDownloadsDir();

  let tasks: SongTask[] = [];

  if (config.mode === 'direct') {
    let directUrl = config.url;
    if (!directUrl) {
      directUrl = await promptForUrl();
    }
    if (!directUrl || !isYoutubeUrl(directUrl)) {
      console.error('A valid YouTube URL is required for direct mode.');
      process.exit(1);
    }
    tasks = [{ id: 1, mode: 'direct', query: directUrl, url: directUrl }];
  } else if (config.mode === 'playlist') {
    let playlistUrl = config.playlistUrl;
    if (!playlistUrl) {
      playlistUrl = await promptForPlaylistUrl();
    }
    if (!playlistUrl || !isYoutubePlaylistUrl(playlistUrl)) {
      console.error('A valid YouTube playlist URL is required for playlist mode.');
      process.exit(1);
    }
    try {
      tasks = await buildPlaylistTasks(playlistUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logFailure(`Playlist load failed (${playlistUrl}) :: ${message}`);
      console.error(`Failed to load playlist: ${message}`);
      process.exit(1);
    }
    if (tasks.length === 0) {
      console.error('No playable videos found in the playlist.');
      process.exit(1);
    }
    const playlistTitle = tasks[0]?.playlistTitle ?? 'Playlist';
    const folderName = await promptForPlaylistFolderName(playlistTitle);
    let playlistDir: string;
    try {
      playlistDir = await createPlaylistDirectory(folderName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logFailure(`Failed to create playlist folder (${folderName}) :: ${message}`);
      console.error(`Could not create playlist folder: ${message}`);
      process.exit(1);
    }
    let startNumber: number | undefined;
    if (await promptForPrefixChoice()) {
      // Scan ALL downloads folders to find the max number across all playlists
      const maxExisting = await getMaxNumberPrefixInDownloads();
      const suggestedStart = maxExisting + 1;
      
      startNumber = await promptForStartingNumber(suggestedStart);
      const endNumber = startNumber + tasks.length - 1;
      console.log(`You will mark files from ${startNumber} to ${endNumber}.`);
    }
    tasks = tasks.map((task, index) => ({
      ...task,
      outputDir: playlistDir,
      sequenceNumber: startNumber !== undefined ? startNumber + index : undefined,
    }));
  } else {
    const songsFile = config.songsFile ?? DEFAULT_SONGS_FILE;
    const titles = await readSongList(songsFile);
    if (titles.length === 0) {
      console.error(`No songs found in ${songsFile}. Add titles and try again.`);
      process.exit(1);
    }
    tasks = buildSongTasks(titles);
  }

  const multiBar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: '{bar} {percentage}% | {title}',
    },
    cliProgress.Presets.shades_grey,
  );

  const limit = pLimit(config.concurrency);

  const results = await Promise.all(
    tasks.map((task) => limit(() => runTask(task, multiBar))),
  );

  multiBar.stop();
  await cleanupPlayerScripts();
  process.stdout.write('\n');

  printSummary(results);

  // Log playlist summary if in playlist mode
  if (config.mode === 'playlist' && tasks.length > 0) {
    const playlistTitle = tasks[0]?.playlistTitle;
    const playlistDir = tasks[0]?.outputDir;
    if (playlistTitle && playlistDir) {
      const completedCount = results.filter((r) => r.status === 'completed').length;
      await logPlaylistSummary(playlistTitle, playlistDir, tasks.length, completedCount);
    }
  }
};

/**
 * Entry point that orchestrates CLI argument parsing, prompting, and session control.
 */
const main = async (): Promise<void> => {
  const rawArgs = process.argv.slice(2);
  const baseConfig = parseArgs(rawArgs);
  const interactive = rawArgs.length === 0;

  if (!interactive) {
    await runDownloadSession(baseConfig);
    return;
  }

  let continueLoop = true;
  while (continueLoop) {
    const chosenMode = await promptForMode();

    let sessionConfig: CliConfig;
    if (chosenMode === 'direct') {
      const directUrl = await promptForUrl();
      sessionConfig = {
        mode: 'direct',
        url: directUrl,
        concurrency: baseConfig.concurrency,
      };
    } else if (chosenMode === 'playlist') {
      const playlistUrl = await promptForPlaylistUrl();
      sessionConfig = {
        mode: 'playlist',
        playlistUrl,
        concurrency: baseConfig.concurrency,
      };
    } else {
      sessionConfig = {
        mode: 'search',
        songsFile: baseConfig.songsFile,
        concurrency: baseConfig.concurrency,
      };
    }

    await runDownloadSession(sessionConfig);

    continueLoop = await promptContinue();
  }

  console.log('\nThanks for using the downloader. Goodbye!');
  process.exit(0);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
