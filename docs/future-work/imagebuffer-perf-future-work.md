# ImageBuffer performance beyond offline-audio parity (future work)

**Status:** Future optimization note — not implemented.  
**Scope:** Image-specific (and live-image) memory/perf after Offline ImageBuffer reaches **AudioBuffer offline parity** (RAM vs mmap, dynamic threshold, temp lifecycle, frame pointers for OCR, decode progress/cancel, `maxSide`).  
**Parent plan:** [`.cursor/plans/ocr_imagebuffer_plan_184e0b27.plan.md`](../../.cursor/plans/ocr_imagebuffer_plan_184e0b27.plan.md)  
**Audio reference:** [`docs/internal/offlineaudiobuffer-internal.md`](../internal/offlineaudiobuffer-internal.md)

---

## Why this is separate from Decode + ImageBuffer v1

v1 must not ship a RAM-only multi-frame buffer that OOMs on multi-page documents. That risk is covered by **parity with OfflineAudioBuffer**, not by the ideas below.

Live audio features (ring, spool, live→offline transfer) map to **LiveImageBuffer** (plan phases Video / Live camera) and stay out of v1 offline.

---

## Audio parity checklist (v1 target — do not defer)

| Offline audio | Offline image (v1) |
|---------------|--------------------|
| `InMemory` / mmap `FileBacked` | Same; raw RGB8 (or gray8) backing files |
| Dynamic mmap threshold | Reuse same policy on `totalBytes` |
| Temp cleanup + orphan sweep | `img_off_*` under cache dir |
| Slice / engine pointer | Per-frame `const uint8_t*` / slice for OCR |
| Decode progress / cancel | Multi-file decode |
| Post-adopt upgrade | Empty + append/populate → mmap |
| — | **`maxSide` at decode** (image-only, required) |

**Explicitly not v1:** live ring/spool, JSI full-pixel bridge, compressed retain, lazy decode, tile OCR.

---

## Future: image-specific optimizations (after parity)

Ordered roughly by leverage for multi-page OCR / PDF later.

| Idea | Benefit | Notes |
|------|---------|--------|
| **Compressed retain** | Keep JPEG/WebP/HEIC bytes; decode RGB only when a frame is used | Cuts resident set vs all frames RGB8 |
| **Lazy / on-demand decode** | Buffer holds URIs/bytes; decode on `recognize(frame)` or first access | Pairs with compressed retain |
| **LRU decoded-frame cache** | Bound RAM to N hot frames; redecode on miss | Needs stable decode cost model |
| **Subsample decode** | JPEG `inSampleSize` / DCT skip before full raster | Peak during decode; PNG weaker |
| **Gray8 path** | Det often gray; ~⅓ of RGB8 | Opt-in `pixelFormat` |
| **OCR tiling** | Overlapping tiles + span merge for huge pages | Avoid crushing text via global downscale |
| **Region / tile decode** | `BitmapRegionDecoder` / tiled PDF render | Viewer + mega-scans; Phase PDF |
| **Mipmap / thumbnail pyramid** | UI without full-res | Extends `getImageFrameThumbnail` |
| **Neighbor prefetch** | ±1 page warm for PDF UX | Phase 2 |
| **Decode into shared pixel buffer** | Fewer intermediate allocs | Refine after mmap lands |
| **Worker / reused ORT sessions** | OCR off UI thread | Engine layer, not buffer storage |

### Live ImageBuffer (phases Video / Camera)

| Idea | Benefit |
|------|---------|
| Fixed ring of recent frames | Bounded RAM while capturing |
| Disk spool of frames / compressed chunks | Survive fast ingest / long sessions |
| Backpressure | Drop or block when OCR lags |
| Live→offline transfer | Finalize session into mmap offline buffer |

Align naming/lifecycle with LiveAudioBuffer where it reduces cognitive load; pixel formats and compression differ.

---

## Non-goals (unless product demands)

- GPU texture atlases as primary OCR backing
- Server-side tile pyramids
- Shipping OpenCV solely for image I/O
- Software HEIC (libheif) as default — see parent plan optional phase

---

## Open questions

1. Backing layout: one contiguous mmap file for all frames vs one file per frame (simpler append/evict)?
2. Threshold on total buffer bytes vs per-frame bytes (or both)?
3. Should compressed retain become default for `createOfflineImageBufferFromFiles` once lazy decode exists?
4. For PDF Phase 2: rasterize all pages into ImageBuffer up front vs page-at-a-time into LRU?

---

## Tentative direction

1. Ship **offline audio parity + maxSide** in Decode/ImageBuffer v1.  
2. Add **compressed retain + lazy decode + LRU** before or with multi-page PDF ingestion.  
3. Add **OCR tiling** when medium/doc workloads hit downscale limits.  
4. Add **live ring/spool** only with Video/Camera phases.
