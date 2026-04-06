/**
 * Compile-time shim for @kesha-antonov/react-native-background-downloader.
 *
 * The package currently ships TS sources without distributable .d.ts files.
 * We route TS path resolution to this shim so the SDK can typecheck strictly
 * without checking third-party TS internals.
 */

export interface BackgroundDownloaderNotificationTexts {
  downloadTitle?: string;
  downloadStarting?: string;
  downloadProgress?: string;
  downloadPaused?: string;
  downloadFinished?: string;
  groupTitle?: string;
  groupText?: string | ((count: number) => string);
}

export type BackgroundDownloaderSetConfigOptions = {
  showNotificationsEnabled?: boolean;
  notificationsGrouping?: {
    enabled?: boolean;
    mode?: 'individual' | 'summaryOnly';
    texts?: BackgroundDownloaderNotificationTexts;
  };
  headers?: Record<string, string>;
  progressInterval?: number;
  progressMinBytes?: number;
  isLogsEnabled?: boolean;
  maxParallelDownloads?: number;
  allowsCellularAccess?: boolean;
};

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

export declare function setConfig(
  options: BackgroundDownloaderSetConfigOptions
): void;

export declare function createDownloadTask(options: {
  id: string;
  url: string;
  destination: string;
  metadata?: Record<string, unknown>;
}): DownloadTask;

export declare function completeHandler(taskId: string): void;
export declare function getExistingDownloadTasks(): Promise<DownloadTask[]>;
