export type TaskMode = 'search' | 'direct' | 'playlist';

export interface SongTask {
  readonly id: number;
  readonly mode: TaskMode;
  readonly query: string;
  readonly url?: string;
  readonly displayTitle?: string;
  readonly playlistTitle?: string;
  readonly outputDir?: string;
  readonly sequenceNumber?: number;
}

export interface TaskResult {
  readonly id: number;
  readonly query: string;
  readonly url: string;
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly filePath?: string;
}
