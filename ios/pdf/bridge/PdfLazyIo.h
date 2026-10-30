#ifndef PdfLazyIo_h
#define PdfLazyIo_h

#import <Foundation/Foundation.h>

@class FileIOReadHandle;

/** Keep a security-scoped read handle alive for a lazy-lru PDF ImageBuffer. */
void SherpaOnnxPdfRetainLazyHandle(NSString *bufferId, FileIOReadHandle *handle);
/** Close the retained handle after ImageRegistry::Release. No-op if unknown. */
void SherpaOnnxPdfReleaseLazyHandle(NSString *bufferId);

#endif /* PdfLazyIo_h */
