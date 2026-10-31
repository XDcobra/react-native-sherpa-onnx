import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { ImageErrorCode } from './types';
import type {
  OfflineImageBufferIdSource,
  OfflineImageFrameInfo,
} from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const IMAGE_BUFFER_ID_PATTERN =
  /^img_(?:off|live)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function resolveImageBufferId(source: OfflineImageBufferIdSource): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    if (
      'bufferId' in source &&
      typeof (source as { bufferId: unknown }).bufferId === 'string'
    ) {
      return (source as { bufferId: string }).bufferId;
    }
  }
  throw new Error(
    `${ImageErrorCode.INVALID_ARGUMENT}: invalid ImageBuffer id source`
  );
}

function assertImageBufferId(id: string): void {
  if (!IMAGE_BUFFER_ID_PATTERN.test(id)) {
    throw new Error(
      `${ImageErrorCode.INVALID_ARGUMENT}: malformed image buffer id: ${id}`
    );
  }
}

function mapFrameInfo(raw: {
  index: number;
  width: number;
  height: number;
  byteSize: number;
  storageKind: string;
  pageNumber?: number;
  dpi?: number;
  sectionIndex?: number;
  href?: string;
  sourceVideoBufferId?: string;
  sourcePtsUs?: number;
  sourceFrameIndex?: number;
  decoderProvider?: string;
  decoderTier?: string;
  decoderOrigin?: string;
}): OfflineImageFrameInfo {
  const frame: OfflineImageFrameInfo = {
    index: raw.index,
    width: raw.width,
    height: raw.height,
    byteSize: raw.byteSize,
    storageKind: raw.storageKind === 'mmap' ? 'mmap' : 'ram',
  };
  if (
    raw.pageNumber != null &&
    Number.isFinite(raw.pageNumber) &&
    raw.pageNumber > 0
  ) {
    frame.pageNumber = Math.trunc(raw.pageNumber);
  }
  if (raw.dpi != null && Number.isFinite(raw.dpi) && raw.dpi > 0) {
    frame.dpi = Math.trunc(raw.dpi);
  }
  if (
    raw.sectionIndex != null &&
    Number.isFinite(raw.sectionIndex) &&
    raw.sectionIndex >= 0
  ) {
    frame.sectionIndex = Math.trunc(raw.sectionIndex);
  }
  const href = typeof raw.href === 'string' ? raw.href : '';
  if (href.length > 0) {
    frame.href = href;
  }
  const vid =
    typeof raw.sourceVideoBufferId === 'string' ? raw.sourceVideoBufferId : '';
  if (
    vid.length > 0 &&
    raw.sourcePtsUs != null &&
    Number.isFinite(raw.sourcePtsUs)
  ) {
    frame.source = {
      videoBufferId: vid,
      ptsUs: raw.sourcePtsUs,
      frameIndex:
        raw.sourceFrameIndex != null && Number.isFinite(raw.sourceFrameIndex)
          ? Math.trunc(raw.sourceFrameIndex)
          : 0,
    };
  }
  if (
    typeof raw.decoderProvider === 'string' &&
    raw.decoderProvider.length > 0
  ) {
    frame.decoder = {
      provider: raw.decoderProvider,
      tier:
        raw.decoderTier === 'hardware' || raw.decoderTier === 'software'
          ? raw.decoderTier
          : 'unknown',
      origin: raw.decoderOrigin === 'bundled' ? 'bundled' : 'platform',
    };
  }
  return frame;
}

export async function getOfflineImageBufferFrameInfo(
  buffer: OfflineImageBufferIdSource,
  frameIndex: number
): Promise<OfflineImageFrameInfo> {
  const id = resolveImageBufferId(buffer);
  assertImageBufferId(id);
  return mapFrameInfo(
    await getNative().getOfflineImageBufferFrameInfo(id, frameIndex)
  );
}
