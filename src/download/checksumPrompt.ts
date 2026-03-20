import { Alert } from 'react-native';
import type { ChecksumIssue } from './types';

export function promptChecksumFallback(issue: ChecksumIssue): Promise<boolean> {
  return new Promise((resolve) => {
    const reasonText =
      issue.reason === 'CHECKSUM_FAILED'
        ? 'Failed to compute checksum.'
        : 'Computed checksum does not match the expected value.';
    const body = `${reasonText}\n\n${issue.message}\n\nDo you want to keep the file and continue?`;

    Alert.alert('Checksum Problem', body, [
      {
        text: 'Delete and cancel',
        style: 'destructive',
        onPress: () => resolve(false),
      },
      {
        text: 'Keep file',
        style: 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}
