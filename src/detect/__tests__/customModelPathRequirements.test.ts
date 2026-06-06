import {
  customModelPathFieldKeys,
  requiredCustomModelPathFieldKeys,
  type CustomModelPathRequirements,
} from '../customModelPathRequirements';

describe('customModelPathFieldKeys', () => {
  const schema: CustomModelPathRequirements = {
    fields: [
      { key: 'ttsModel', required: true, kind: 'file' },
      { key: 'tokens', required: true, kind: 'file' },
      { key: 'dataDir', required: false, kind: 'dir' },
    ],
  };

  it('lists all keys in order', () => {
    expect(customModelPathFieldKeys(schema)).toEqual([
      'ttsModel',
      'tokens',
      'dataDir',
    ]);
  });

  it('lists required keys only', () => {
    expect(requiredCustomModelPathFieldKeys(schema)).toEqual([
      'ttsModel',
      'tokens',
    ]);
  });
});
