/**
 * File-based playback via react-native-audio-api (Web Audio-style API).
 * Reads bytes with react-native-fs (avoids fetch(file://) issues) and decodes in-process.
 */

import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';
import { readFile } from '@dr.pogodin/react-native-fs';
import { copyFile } from 'react-native-sherpa-onnx/fileio';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

import { Buffer } from 'buffer';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = Buffer.from(base64, 'base64');
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/** Resolve content:// to a cache file path; strip file:// for readFile. */
export async function resolveAudioPathForRead(
  pathOrUri: string
): Promise<string> {
  if (pathOrUri.startsWith('content://')) {
    const source: FileSource = { kind: 'contentUri', uri: pathOrUri };
    const dest: import('react-native-sherpa-onnx/fileio').FileDestination = {
      kind: 'app',
      base: 'cache',
      path: `example_audio_${Date.now()}.wav`,
    };
    const result = await copyFile(source, dest);
    return result.output.kind === 'fs' ? result.output.path : pathOrUri;
  }
  if (pathOrUri.startsWith('file://')) {
    return pathOrUri.replace(/^file:\/\//, '');
  }
  return pathOrUri;
}

export async function loadAudioAsArrayBuffer(
  pathOrUri: string
): Promise<ArrayBuffer> {
  const path = await resolveAudioPathForRead(pathOrUri);
  const base64 = await readFile(path, 'base64');
  return base64ToArrayBuffer(base64);
}

export type ActiveWebAudioPlayback = {
  context: AudioContext;
  source: AudioBufferSourceNode;
};

export function stopWebAudioPlayback(
  active: ActiveWebAudioPlayback | null
): void {
  if (!active) return;
  try {
    active.source.stop();
  } catch {
    /* already stopped or not started */
  }
  active.context.close().catch(() => {});
}

export async function startWebAudioFilePlayback(
  pathOrUri: string,
  onPlaybackEnded?: () => void
): Promise<ActiveWebAudioPlayback> {
  const arrayBuffer = await loadAudioAsArrayBuffer(pathOrUri);
  const context = new AudioContext();
  const audioBuffer = await context.decodeAudioData(arrayBuffer);
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  source.onEnded = () => {
    onPlaybackEnded?.();
    context.close().catch(() => {});
  };
  source.start();
  return { context, source };
}
