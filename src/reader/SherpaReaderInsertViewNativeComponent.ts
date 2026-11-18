import {
  codegenNativeComponent,
  type CodegenTypes,
  type HostComponent,
  type ViewProps,
} from 'react-native';

/**
 * Host for one insert or one margin marker. `SherpaReaderView` moves its host
 * views into list cells (inserts) or next to their anchor line (markers), so
 * every insert and marker view is wrapped in exactly one of these.
 */
export interface NativeProps extends ViewProps {
  /** Insert hosts: the insert key ("" for a marker host). */
  insertKey?: CodegenTypes.WithDefault<string, ''>;
  /** Marker hosts: the marker ID ("" for an insert host). */
  markerId?: CodegenTypes.WithDefault<string, ''>;
}

// interfaceOnly: the shadow node is hand-written (cpp/fabric/…/SherpaReaderInsertShadowNode)
// so the host can report its on-screen offset to `measure`.
export default codegenNativeComponent<NativeProps>('SherpaReaderInsertView', {
  interfaceOnly: true,
}) as HostComponent<NativeProps>;
