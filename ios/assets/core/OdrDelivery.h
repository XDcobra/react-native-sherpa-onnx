#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^SherpaOnnxOdrProgressHandler)(NSDictionary *state);

/**
 * On-Demand Resources (ODR) for shipped model archives.
 * Tag names are app-defined (often aligned with Android PAD pack names).
 */
@interface SherpaOnnxOdrDelivery : NSObject

+ (instancetype)shared;

/** Canonical …/{tag}/models while ODR access is held (PAD-style; content not inspected). */
- (nullable NSString *)assetPackModelsPath:(NSString *)tag;

/**
 * Delivery snapshot for {@p listOdrDeliverySnapshot}. Always includes {@p tag} and
 * {@p resolvedModelsPath}; further fields are present in DEBUG builds only.
 */
- (NSDictionary *)odrSnapshotForTag:(NSString *)tag bundle:(NSBundle *)bundle;

#if DEBUG
- (void)logOdrDiagnosticsForTag:(NSString *)tag bundle:(NSBundle *_Nullable)bundle;
#endif

- (BOOL)isTagReady:(NSString *)tag;

/** Start ODR download for {@p tag} (Promise-style callbacks for the RN bridge). */
- (void)fetchAssetPack:(NSString *)tag
               resolve:(void (^)(id result))resolve
                reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

/**
 * Fetch if needed and resolve when ODR access for {@p tag} is active.
 * Progress via {@p progressHandler} (bridge maps to sherpaAssetPackDeliveryProgress).
 */
- (void)ensureAssetPackReady:(NSString *)tag
             progressHandler:(SherpaOnnxOdrProgressHandler _Nullable)progressHandler
                     resolve:(void (^)(id result))resolve
                      reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

- (void)getAssetPackState:(NSString *)tag
                  resolve:(void (^)(id result))resolve
                   reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

/** End ODR access for {@p tag}; does not delete extracted Documents/models/. */
- (void)removeAssetPack:(NSString *)tag
                resolve:(void (^)(id result))resolve
                 reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

/** iOS debug/diagnostics: {@p odrSnapshotForTag} (delivery only; no archive listing). */
- (void)listOdrDeliverySnapshot:(NSString *)tag
                        resolve:(void (^)(id result))resolve
                         reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

@end

NS_ASSUME_NONNULL_END
