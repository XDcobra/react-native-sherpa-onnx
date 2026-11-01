jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    createSpeakerEmbeddingManager: jest.fn(),
    destroySpeakerEmbeddingManager: jest.fn(),
    speakerEmbeddingManagerGetEmbedding: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createSpeakerEmbeddingManager } from '../manager';

describe('SpeakerEmbeddingManager.getEmbedding', () => {
  const native = SherpaOnnx as unknown as {
    createSpeakerEmbeddingManager: jest.Mock;
    speakerEmbeddingManagerGetEmbedding: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.createSpeakerEmbeddingManager.mockResolvedValue({ success: true });
  });

  it('returns a Float32Array when native has the name', async () => {
    native.speakerEmbeddingManagerGetEmbedding.mockResolvedValue({
      embedding: [1, 2, 3, 4],
    });
    const manager = await createSpeakerEmbeddingManager(4);
    await expect(manager.getEmbedding('alice')).resolves.toEqual(
      new Float32Array([1, 2, 3, 4])
    );
    expect(native.speakerEmbeddingManagerGetEmbedding).toHaveBeenCalledWith(
      manager.managerId,
      'alice'
    );
  });

  it('returns null when the name is not enrolled', async () => {
    native.speakerEmbeddingManagerGetEmbedding.mockResolvedValue({
      embedding: null,
    });
    const manager = await createSpeakerEmbeddingManager(4);
    await expect(manager.getEmbedding('missing')).resolves.toBeNull();
  });

  it('rejects an empty name', async () => {
    const manager = await createSpeakerEmbeddingManager(4);
    await expect(manager.getEmbedding('')).rejects.toThrow(
      /SPEAKER_EMBEDDING_MANAGER_ERROR/
    );
    expect(native.speakerEmbeddingManagerGetEmbedding).not.toHaveBeenCalled();
  });
});
