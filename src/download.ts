import path from 'node:path';
import fs from 'fs-extra';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ytdl from '@distube/ytdl-core';
import { sanitizeFileName } from './utils.js';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

export interface DownloadOptions {
  readonly url: string;
  readonly title: string;
  readonly outputDir: string;
  readonly onProgress: (percent: number, downloaded: number, total: number) => void;
}

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.youtube.com/',
  Origin: 'https://www.youtube.com',
};

/**
 * Downloads audio via ytdl-core and returns the final mp3 path.
 */
const downloadWithCore = async (
  url: string,
  targetPath: string,
  tempPath: string,
  onProgress: (percent: number, downloaded: number, total: number) => void,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const stream = ytdl(url, {
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
      dlChunkSize: 1 << 20,
      requestOptions: { headers: REQUEST_HEADERS },
    });

    stream.on('progress', (_chunkLength: number, downloaded: number, total: number) => {
      const percent = total > 0 ? downloaded / total : 0;
      onProgress(percent, downloaded, total);
    });

    stream.on('error', (error: Error) => {
      void fs.remove(tempPath);
      reject(error);
    });

    ffmpeg(stream)
      .audioBitrate(128)
      .format('mp3')
      .on('error', (error: Error) => {
        void fs.remove(tempPath);
        reject(error);
      })
      .on('end', async () => {
        try {
          await fs.move(tempPath, targetPath, { overwrite: true });
          resolve(targetPath);
        } catch (error) {
          reject(error as Error);
        }
      })
      .save(tempPath);
  });

/**
 * Invokes yt-dlp as a resilient fallback when ytdl-core cannot decode signatures.
 */
let ytDlpWrapInstance: unknown = null;
let ytDlpWrapPromise: Promise<unknown> | null = null;

/**
 * Lazily instantiates the yt-dlp wrapper so we reuse the downloaded binary across requests.
 */
interface YtDlpEmitter {
  on: (event: string, listener: (...args: unknown[]) => void) => YtDlpEmitter;
  once: (event: string, listener: (...args: unknown[]) => void) => YtDlpEmitter;
}

const getYtDlp = async (): Promise<{
  exec: (args: string[]) => YtDlpEmitter;
  execPromise: (args: string[]) => Promise<string>;
}> => {
  if (ytDlpWrapInstance) {
    return ytDlpWrapInstance as {
      exec: (args: string[]) => YtDlpEmitter;
      execPromise: (args: string[]) => Promise<string>;
    };
  }

  if (!ytDlpWrapPromise) {
    ytDlpWrapPromise = import('yt-dlp-wrap').then(async (module) => {
      const Constructor = module.default as unknown as {
        new (binaryPath?: string): {
          exec: (args: string[]) => YtDlpEmitter;
          execPromise: (args: string[]) => Promise<string>;
        };
        downloadFromGithub?: (filePath?: string) => Promise<void>;
      };

      const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const binaryPath = path.resolve(process.cwd(), binaryName);
      const exists = await fs.pathExists(binaryPath);

      if (!exists && typeof Constructor.downloadFromGithub === 'function') {
        await Constructor.downloadFromGithub(binaryPath);
      }

      ytDlpWrapInstance = new Constructor(binaryPath);
      return ytDlpWrapInstance;
    });
  }

  const instance = await ytDlpWrapPromise;
  return instance as {
    exec: (args: string[]) => YtDlpEmitter;
    execPromise: (args: string[]) => Promise<string>;
  };
};

/**
 * Executes yt-dlp as a resilient fallback when signature deciphering fails upstream.
 */
const downloadWithYtDlp = async (
  url: string,
  targetPath: string,
  onProgress: (percent: number) => void,
): Promise<string> => {
  const args = [
    url,
    '-o',
    targetPath,
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '5',
    '--no-part',
    '--force-overwrites',
    '--newline',
    '--no-warnings',
    '--quiet',
  ];

  if (typeof ffmpegStatic === 'string') {
    args.push('--ffmpeg-location', ffmpegStatic);
  }

  const ytDlp = await getYtDlp();

  await new Promise<void>((resolve, reject) => {
    const runner = ytDlp.exec(args);
    let lastPercent = 0;

    const handleProgress = (...progressArgs: unknown[]): void => {
      const [raw] = progressArgs;
      if (raw && typeof raw === 'object' && 'percent' in raw) {
        const percentValue = (raw as { percent?: string | number }).percent;
        const numeric =
          typeof percentValue === 'number'
            ? percentValue
            : typeof percentValue === 'string'
              ? Number.parseFloat(percentValue.replace('%', ''))
              : Number.NaN;
        if (!Number.isNaN(numeric)) {
          lastPercent = numeric;
          onProgress(Math.min(1, Math.max(0, numeric / 100)));
        }
      }
    };

    runner.on('progress', handleProgress);
    runner.once('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    runner.once('close', (code: unknown) => {
      if (typeof code !== 'number' || code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      if (lastPercent < 100) {
        onProgress(1);
      }
      resolve();
    });
  });

  return targetPath;
};

/**
 * Determines whether we should escalate to the yt-dlp fallback based on the error surface.
 */
const shouldFallback = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /Status code: 403/i.test(message) || /Could not parse/i.test(message) || /decipher/i.test(message);
};

/**
 * Fetches a YouTube audio stream and converts it into an mp3 file using ffmpeg with yt-dlp fallback.
 */
export const downloadToMp3 = async ({
  url,
  title,
  outputDir,
  onProgress,
}: DownloadOptions): Promise<string> => {
  if (!ytdl.validateURL(url)) {
    throw new Error('Invalid YouTube URL');
  }

  await fs.ensureDir(outputDir);

  const baseName = title.length > 0 ? title : `youtube-audio-${Date.now()}`;
  const safeBase = sanitizeFileName(baseName) || `youtube-audio-${Date.now()}`;
  const targetPath = path.resolve(outputDir, `${safeBase}.mp3`);
  const tempPath = `${targetPath}.part`;

  await fs.remove(tempPath);

  try {
    return await downloadWithCore(url, targetPath, tempPath, onProgress);
  } catch (error) {
    if (!shouldFallback(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    const fallbackPath = await downloadWithYtDlp(url, targetPath, (percent: number) => {
      onProgress(percent, 0, 0);
    });
    onProgress(1, 0, 0);
    return fallbackPath;
  }
};
