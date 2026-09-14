import { describe, expect, it } from '@jest/globals';
import {
  classifyAssetPackDeliveryFailure,
  isRetryableAssetPackFailure,
} from '../assetPack';

describe('classifyAssetPackDeliveryFailure', () => {
  it('maps network and access-denied messages', () => {
    expect(
      classifyAssetPackDeliveryFailure(
        new Error('Asset pack core_vad failed (errorCode=-6)')
      )
    ).toBe('network');
    expect(
      classifyAssetPackDeliveryFailure(
        Object.assign(new Error('Download not permitted'), {
          name: 'PAD_ACCESS_DENIED',
        })
      )
    ).toBe('background_denied');
  });

  it('maps play unavailable / binder death', () => {
    expect(
      classifyAssetPackDeliveryFailure(
        Object.assign(new Error('AssetPackService : Binder has died.'), {
          name: 'PAD_PLAY_UNAVAILABLE',
        })
      )
    ).toBe('play_unavailable');
  });

  it('maps stalled', () => {
    expect(
      classifyAssetPackDeliveryFailure(
        Object.assign(new Error('stalled'), { name: 'PAD_STALLED' })
      )
    ).toBe('stalled');
  });

  it('marks play_unavailable as non-retryable', () => {
    expect(isRetryableAssetPackFailure('play_unavailable')).toBe(false);
    expect(isRetryableAssetPackFailure('network')).toBe(true);
    expect(isRetryableAssetPackFailure('background_denied')).toBe(true);
    expect(isRetryableAssetPackFailure('stalled')).toBe(true);
  });
});
