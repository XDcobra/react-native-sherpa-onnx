import type {
  OfflinePunctuationCustomPathKey,
  StreamingPunctuationCustomPathKey,
} from 'react-native-sherpa-onnx/punctuation';

const OFFLINE_LABELS: Record<OfflinePunctuationCustomPathKey, string> = {
  ct_transformer: 'CT-Transformer ONNX',
};

const STREAMING_LABELS: Record<StreamingPunctuationCustomPathKey, string> = {
  cnn_bilstm: 'CNN-BiLSTM ONNX',
  bpe_vocab: 'BPE vocabulary',
};

export function labelForOfflinePunctuationCustomPathKey(
  key: OfflinePunctuationCustomPathKey
): string {
  return OFFLINE_LABELS[key] ?? key;
}

export function labelForStreamingPunctuationCustomPathKey(
  key: StreamingPunctuationCustomPathKey
): string {
  return STREAMING_LABELS[key] ?? key;
}
