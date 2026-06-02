import { Platform } from 'react-native';
import { FileIOErrorCode } from './types';
import type { FileDestination, FileSource } from './types';

export function createFileIOError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

export function assertFileSourceSupportedOnPlatform(source: FileSource): void {
  if (source.kind === 'auto') {
    return;
  }

  if (Platform.OS === 'android') {
    if (source.kind === 'securityScoped') {
      throw createFileIOError(
        FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
        'securityScoped source is iOS-only. Use fs/app/contentUri/pad on Android.'
      );
    }
    if (source.kind === 'app' && source.base === 'appBundle') {
      throw createFileIOError(
        FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
        'app:appBundle source is iOS-only. Use app:apkAsset/fs/pad on Android.'
      );
    }
  }

  if (Platform.OS === 'ios') {
    if (source.kind === 'contentUri' || source.kind === 'pad') {
      throw createFileIOError(
        FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
        `${source.kind} source is Android-only. Use fs/app/securityScoped on iOS.`
      );
    }
    if (source.kind === 'app' && source.base === 'apkAsset') {
      throw createFileIOError(
        FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
        'app:apkAsset source is Android-only. Use app:appBundle/fs on iOS.'
      );
    }
  }
}

export function assertFileDestinationSupportedOnPlatform(
  destination: FileDestination
): void {
  if (Platform.OS === 'ios') {
    if (
      destination.kind === 'contentUri' ||
      destination.kind === 'contentTree'
    ) {
      throw createFileIOError(
        FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
        `${destination.kind} destination is Android-only. Use fs/app/securityScoped on iOS.`
      );
    }
  }

  if (Platform.OS === 'android' && destination.kind === 'securityScoped') {
    throw createFileIOError(
      FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
      'securityScoped destination is iOS-only. Use fs/app/contentUri/contentTree on Android.'
    );
  }

  if (
    destination.kind === 'app' &&
    ((Platform.OS === 'android' && destination.base === 'appBundle') ||
      (Platform.OS === 'ios' && destination.base === 'apkAsset'))
  ) {
    throw createFileIOError(
      FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
      `app:${destination.base} is not supported on ${Platform.OS}.`
    );
  }
}

export function assertFileLocationsSupportedOnPlatform(
  source: FileSource,
  destination: FileDestination
): void {
  assertFileSourceSupportedOnPlatform(source);
  assertFileDestinationSupportedOnPlatform(destination);
}
