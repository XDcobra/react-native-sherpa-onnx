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

// interfaceOnly: the shadow node is hand-written (cpp/fabric/…/SherpaReaderInsertShadowNode)
// so the host can report its on-screen offset to `measure`.
export default codegenNativeComponent<NativeProps>('SherpaReaderInsertView', {
  interfaceOnly: true,
}) as HostComponent<NativeProps>;
