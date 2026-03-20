/**
 * Type declarations for @kesha-antonov/react-native-background-downloader
 * when the package is not installed (e.g. SDK build). The real package provides full types.
 */
declare module '@kesha-antonov/react-native-background-downloader' {
  export interface DownloadTask {
    id: string;
    start(): void;
    stop(): void;
    pause(): Promise<void>;
    resume(): Promise<void>;
    begin(
      cb: (data: {
        expectedBytes?: number;
        headers?: Record<string, string>;
      }) => void
    ): DownloadTask;
    progress(
      cb: (data: { bytesDownloaded: number; bytesTotal: number }) => void
    ): DownloadTask;
    done(
      cb: (data: {
        location?: string;
        bytesDownloaded: number;
        bytesTotal: number;
      }) => void
    ): DownloadTask;
    error(
      cb: (data: { error?: string; errorCode?: number }) => void
    ): DownloadTask;
  }

  export function createDownloadTask(options: {
    id: string;
    url: string;
    destination: string;
    metadata?: Record<string, unknown>;
  }): DownloadTask;

  export function completeHandler(taskId: string): void;

  export function getExistingDownloadTasks(): Promise<DownloadTask[]>;
}
