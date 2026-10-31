export type CodecPolicy = 'hardware' | 'software' | 'preferHardware';
export type CodecTier = 'hardware' | 'software' | 'unknown';
export type CodecOrigin = 'platform' | 'bundled';
export type CodecUnavailableReason =
  | 'pool-full'
  | 'not-present'
  | 'disabled'
  | 'os-too-old'
  | 'unsupported-stream'
  | 'configure-failed'
  | 'reclaimed'
  | 'invalid-session'
  | 'sw-too-slow';

export type CodecResource =
  | 'hwVideoDecode'
  | 'hwVideoDisplay'
  | 'hwVideoEncode'
  | 'swVideoDecode'
  | 'swVideoEncode'
  | 'platformImageDecode';

export interface CodecAttempt {
  provider: string;
  tier: CodecTier;
  origin: CodecOrigin;
  reason: CodecUnavailableReason;
  code?: string;
}

export interface CodecDecision {
  tier: CodecTier;
  origin: CodecOrigin;
  provider: string;
  fallbackFrom?: { code: string; reason: CodecUnavailableReason };
  attempts?: CodecAttempt[];
}

export interface ConfigureCodecsOptions {
  video?: { decode?: CodecPolicy; display?: CodecPolicy; encode?: CodecPolicy };
  image?: { decode?: CodecPolicy };
  budgets?: Partial<Record<CodecResource, number>>;
}

export interface CodecInfo {
  ramClass: 'low' | 'mid' | 'high' | 'veryHigh';
  policies: Required<NonNullable<ConfigureCodecsOptions['video']>> & {
    imageDecode: CodecPolicy;
  };
  slots: Array<{
    resource: CodecResource;
    max: number;
    inUse: number;
    source: 'auto' | 'override';
  }>;
  providers: Array<{
    media: 'video' | 'image';
    direction: 'decode' | 'encode';
    codec: string;
    tier: CodecTier;
    origin: CodecOrigin;
    provider: string;
    available: boolean;
    reason?: CodecUnavailableReason;
    maxWidth?: number;
    maxHeight?: number;
    maxInstances?: number;
  }>;
}

export type CodecEvent =
  | { type: 'slotFreed'; resource: CodecResource; max: number; inUse: number }
  | {
      type: 'fallback';
      owner: string;
      use: 'cpu' | 'display' | 'export' | 'image';
      decision: CodecDecision;
    };

export const CODEC_POLICIES: readonly CodecPolicy[] = [
  'hardware',
  'software',
  'preferHardware',
];

export const CODEC_RESOURCES: readonly CodecResource[] = [
  'hwVideoDecode',
  'hwVideoDisplay',
  'hwVideoEncode',
  'swVideoDecode',
  'swVideoEncode',
  'platformImageDecode',
];
