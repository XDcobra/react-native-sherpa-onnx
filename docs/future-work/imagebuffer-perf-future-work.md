# ImageBuffer performance beyond offline-audio parity (future work)

**Status:** Future optimization note — not implemented (except items already shipped in public docs).  
**Scope:** Image-specific (and live-image) memory/perf **beyond** what Offline ImageBuffer already ships.  
**Shipped already (do not re-plan here):** RAM vs mmap, dynamic threshold, temp lifecycle, `GetFrameRgbPtr`, decode progress/cancel, `maxSide`, PDF `rasterizePdfPages`, `OfflineImageBufferFrameView`, `exportOfflineImageBufferFrame`. See [imagebuffer-offline.md](../imagebuffer-offline.md) and [pdf-offline.md](../pdf-offline.md).  
**Audio reference:** [`docs/internal/offlineaudiobuffer-internal.md`](../internal/offlineaudiobuffer-internal.md)

---

## Remaining image-specific optimizations

Ordered roughly by leverage for multi-page OCR / large PDF.

| Idea | Benefit | Notes |
|------|---------|--------|
| **PDF lazy raster + LRU** (`strategy` / `hotFrames`) | Bound decoded RGB to N hot pages; PDF stays source of truth | Primary next slice — see plan `pdf_lazy_lru_imagebuffer` |
| **Compressed retain** (file images) | Keep JPEG/WebP/HEIC bytes; decode RGB only when a frame is used | After or alongside PDF lazy |
| **Lazy / on-demand decode** (file images) | Buffer holds URIs/bytes; decode on `recognize(frame)` or first access | Pairs with compressed retain |
| **Subsample decode** | JPEG `inSampleSize` / DCT skip before full raster | Peak during decode; PNG weaker |
| **Gray8 path** | Det often gray; ~⅓ of RGB8 | Opt-in `pixelFormat` |
| **OCR tiling** | Overlapping tiles + span merge for huge pages | Avoid crushing text via global downscale |
| **Region / tile decode** | `BitmapRegionDecoder` / tiled PDF render | Viewer + mega-scans |
| **Mipmap / thumbnail pyramid** | UI without full-res | |
| **Neighbor prefetch** | ±1 page warm for PDF UX | Natural companion to PDF lazy-LRU |
| **Decode into shared pixel buffer** | Fewer intermediate allocs | |
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
- Software HEIC (libheif) as default

---

## Open questions

1. Backing layout for hot frames under LRU: one mmap file per frame (simpler evict) vs shared region?
2. Threshold on total buffer bytes vs per-frame bytes (or both) once lazy slots exist?
3. Should compressed retain become default for `createOfflineImageBufferFromFiles` once lazy decode exists?

---

## Tentative direction

1. **PDF lazy-LRU** (`rasterizePdfPages` `strategy` + `hotFrames`) for large documents.  
2. **Compressed retain + lazy decode** for multi-file image buffers.  
3. **OCR tiling** when medium/doc workloads hit downscale limits.  
4. **Live ring/spool** only with Video/Camera phases.
