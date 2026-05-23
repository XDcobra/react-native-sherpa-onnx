import {
  buildOnlineSttInitBridgeOptions,
  buildSttInitBridgeOptions,
} from '../sttNativeBridge';

describe('sttNativeBridge', () => {
  it('buildSttInitBridgeOptions maps public STT options to bridge map', () => {
    const bridge = buildSttInitBridgeOptions('/models/whisper', {
      modelSource: { kind: 'fs', path: '/models/whisper' },
      modelType: 'whisper',
      preferInt8: true,
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
    expect(bridge).toEqual({
      modelDir: '/models/whisper',
      modelType: 'whisper',
      preferInt8: true,
      debug: true,
      modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
    });
  });

  it('buildOnlineSttInitBridgeOptions flattens endpoint rules', () => {
    const bridge = buildOnlineSttInitBridgeOptions('/models/stream', {
      modelSource: { kind: 'fs', path: '/models/stream' },
      modelType: 'transducer',
      enableEndpoint: true,
      endpointConfig: {
        rule1: {
          mustContainNonSilence: false,
          minTrailingSilence: 2.4,
          minUtteranceLength: 0,
        },
      },
    });
    expect(bridge.modelDir).toBe('/models/stream');
    expect(bridge.modelType).toBe('transducer');
    expect(bridge.enableEndpoint).toBe(true);
    expect(bridge.rule1MinTrailingSilence).toBe(2.4);
    expect(bridge.rule1MustContainNonSilence).toBe(false);
  });
});
