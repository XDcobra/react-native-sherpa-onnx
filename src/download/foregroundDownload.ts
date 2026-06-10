import { NativeEventEmitter, NativeModules } from 'react-native';
import NativeSherpaOnnx from '../NativeSherpaOnnx';

export interface ForegroundDownloadTask {
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
  ): ForegroundDownloadTask;
  progress(
    cb: (data: { bytesDownloaded: number; bytesTotal: number }) => void
  ): ForegroundDownloadTask;
  done(
    cb: (data: {
      location?: string;
      bytesDownloaded: number;
      bytesTotal: number;
    }) => void
  ): ForegroundDownloadTask;
  error(
    cb: (data: { error?: string; errorCode?: number }) => void
  ): ForegroundDownloadTask;
}

type TaskHandlers = {
  begin?: (data: {
    expectedBytes?: number;
    headers?: Record<string, string>;
  }) => void;
  progress?: (data: { bytesDownloaded: number; bytesTotal: number }) => void;
  done?: (data: {
    location?: string;
    bytesDownloaded: number;
    bytesTotal: number;
  }) => void;
  error?: (data: { error?: string; errorCode?: number }) => void;
};

const handlersByTaskId = new Map<string, TaskHandlers>();
let globalListenersInstalled = false;

function getEmitter(): NativeEventEmitter {
  return new NativeEventEmitter(NativeModules.SherpaOnnx as any);
}

function ensureGlobalListeners(): void {
  if (globalListenersInstalled) {
    return;
  }
  globalListenersInstalled = true;
  const emitter = getEmitter();

  emitter.addListener(
    'sherpaForegroundDownloadBegin',
    (event: {
      id?: string;
      expectedBytes?: number;
      headers?: Record<string, string>;
    }) => {
      const id = event?.id;
      if (!id) {
        return;
      }
      handlersByTaskId.get(id)?.begin?.({
        expectedBytes: event.expectedBytes,
        headers: event.headers,
      });
    }
  );

  emitter.addListener(
    'sherpaForegroundDownloadProgress',
    (event: { id?: string; bytesDownloaded?: number; bytesTotal?: number }) => {
      const id = event?.id;
      if (!id) {
        return;
      }
      handlersByTaskId.get(id)?.progress?.({
        bytesDownloaded: event.bytesDownloaded ?? 0,
        bytesTotal: event.bytesTotal ?? -1,
      });
    }
  );

  emitter.addListener(
    'sherpaForegroundDownloadComplete',
    (event: {
      id?: string;
      location?: string;
      bytesDownloaded?: number;
      bytesTotal?: number;
    }) => {
      const id = event?.id;
      if (!id) {
        return;
      }
      const handlers = handlersByTaskId.get(id);
      handlers?.done?.({
        location: event.location,
        bytesDownloaded: event.bytesDownloaded ?? 0,
        bytesTotal: event.bytesTotal ?? 0,
      });
      handlersByTaskId.delete(id);
    }
  );

  emitter.addListener(
    'sherpaForegroundDownloadError',
    (event: { id?: string; error?: string; errorCode?: number }) => {
      const id = event?.id;
      if (!id) {
        return;
      }
      const handlers = handlersByTaskId.get(id);
      handlers?.error?.({
        error: event.error,
        errorCode: event.errorCode,
      });
      handlersByTaskId.delete(id);
    }
  );
}

function unregisterTaskHandlers(taskId: string): void {
  handlersByTaskId.delete(taskId);
}

export function createForegroundDownloadTask(options: {
  id: string;
  url: string;
  destination: string;
  headers?: Record<string, string>;
}): ForegroundDownloadTask {
  ensureGlobalListeners();

  const handlers: TaskHandlers = {};
  handlersByTaskId.set(options.id, handlers);

  const task: ForegroundDownloadTask = {
    id: options.id,
    begin(cb) {
      handlers.begin = cb;
      return task;
    },
    progress(cb) {
      handlers.progress = cb;
      return task;
    },
    done(cb) {
      handlers.done = cb;
      return task;
    },
    error(cb) {
      handlers.error = cb;
      return task;
    },
    start() {
      NativeSherpaOnnx.startForegroundDownload(
        options.id,
        options.url,
        options.destination,
        options.headers
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        handlers.error?.({ error: message, errorCode: -1 });
        unregisterTaskHandlers(options.id);
      });
    },
    stop() {
      NativeSherpaOnnx.cancelForegroundDownload(options.id).catch(() => {});
      unregisterTaskHandlers(options.id);
    },
    async pause() {
      await NativeSherpaOnnx.pauseForegroundDownload(options.id);
    },
    async resume() {
      const resumed = await NativeSherpaOnnx.resumeForegroundDownload(
        options.id
      );
      if (!resumed) {
        // App restart or stale session: resume via Range from bytes on disk.
        NativeSherpaOnnx.startForegroundDownload(
          options.id,
          options.url,
          options.destination,
          options.headers
        ).catch(() => {});
      }
    },
  };

  return task;
}

export async function cancelForegroundDownload(taskId: string): Promise<void> {
  try {
    await NativeSherpaOnnx.cancelForegroundDownload(taskId);
  } finally {
    unregisterTaskHandlers(taskId);
  }
}
