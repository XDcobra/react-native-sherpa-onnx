#ifndef PdfLazyIo_h
#define PdfLazyIo_h

#import <Foundation/Foundation.h>

@class FileIOReadHandle;

/**
 * Keep a security-scoped read handle alive for a lazy-lru ImageBuffer that
 * reads its file later (PDF pages, comic archive pages).
 */
void SherpaOnnxPdfRetainLazyHandle(NSString *bufferId, FileIOReadHandle *handle);
/** Close the retained handle after ImageRegistry::Release. No-op if unknown. */
void SherpaOnnxPdfReleaseLazyHandle(NSString *bufferId);

#endif /* PdfLazyIo_h */
