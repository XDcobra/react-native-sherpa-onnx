import {
  codegenNativeComponent,
  type HostComponent,
  type ViewProps,
} from 'react-native';

/**
 * Host for one insert. `SherpaReaderView` moves its host views into list cells,
 * so every insert must be wrapped in exactly one of these.
 */
export interface NativeProps extends ViewProps {
  insertKey: string;
}

export default codegenNativeComponent<NativeProps>(
  'SherpaReaderInsertView'
) as HostComponent<NativeProps>;
