# ReaderView insert spike (phase 1)

Goal: React Native views ("inserts") inside the native, virtualized reader list,
on Fabric. Setup: `example/src/screens/reader/ReaderScreen.tsx` with 80 placeholder
rows (`__debugRowCount`) and three inserts (`afterBlock`, `sectionEnd`, `beforeBlock`).

## How it works

- `SherpaReaderView` (Fabric component) gets insert hosts as React children but
  does not add them as subviews. iOS overrides `mountChildComponentView` /
  `unmountChildComponentView` (no `super`); Android keeps a logical child list in
  the `ViewGroupManager` (`addView` / `removeViewAt` / `getChildAt`) and returns
  `needsCustomLayoutForChildren() = true`.
- Each insert is wrapped in `SherpaReaderInsertView`. Yoga lays it out at full
  reader width; the list reads the Yoga height for the row and moves the host
  into the row's cell.
- **Shadow state for `measure`** (`cpp/fabric/.../SherpaReaderInsertShadowNode`):
  Yoga puts every host at the reader's top-left, but on screen it sits in its row.
  Pressability measures the press rect from the shadow tree, so a tap with a
  little finger movement was dropped when the insert was far down. The host's
  hand-written shadow node reports its on-screen position (pushed by the list on
  scroll / layout) as `getContentOriginOffset`, so descendants measure correctly.
  The insert component is `interfaceOnly`; Android builds the codegen library from
  `android/src/main/jni-codegen` and registers both descriptors via
  `react-native.config.js`.
- iOS keeps the first visible row anchored across row changes and caches measured
  block heights as estimates (otherwise UIKit re-estimates rows above the
  viewport on `beginUpdates`/`endUpdates` and the content jumps).
- iOS table: `insetsContentViewsToSafeArea = NO` so hosts sit at React's x.
- Drag in the list cancels the JS responder (iOS: toggle the surface touch
  handler; Android: `NativeGestureUtil`).

## Results (iOS 27 simulator, iPhone 17 Pro, driven via Xcode DeviceHub)

| # | Check | Result |
|---|---|---|
| 1 | Add / remove / move inserts while scrolled | ✅ rows update, insert re-mounts and stays tappable |
| 2 | Insert grows above the viewport | ✅ pixel-identical viewport (anchor kept) |
| 3 | Tap a Pressable in an insert far down, with 5–8 pt movement | ✅ (after the shadow-state fix; also in landscape) |
| 4 | Drag that starts on an insert | ✅ list scrolls, no press |
| 5 | Accessibility order | ✅ hierarchy lists inserts between their blocks |
| 6 | Cell reuse over 80 rows + 3 inserts | ✅ |
| 7 | Fast refresh, leaving the screen with inserts mounted | ✅ no crash, no JS exception |
| 8 | Rotation | ✅ inserts full width, tappable |

Android: builds (`assembleDebug`), autolinking registers both descriptors; device
test pending (see status in the implementation plan).
