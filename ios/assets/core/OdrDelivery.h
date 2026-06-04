#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^SherpaOnnxOdrProgressHandler)(NSDictionary *state);

/**
 * On-Demand Resources (ODR) for shipped model archives.
 * Tag names align with Android PAD pack names (e.g. core_models, studio_models).
 */
@interface SherpaOnnxOdrDelivery : NSObject

+ (instancetype)shared;

/** Models directory inside the bundle after the tag is available (…/TagName/models). */
- (nullable NSString *)assetPackModelsPath:(NSString *)tag;

- (BOOL)isTagReady:(NSString *)tag;

/** Start ODR download for {@p tag} (Promise-style callbacks for the RN bridge). */
- (void)fetchAssetPack:(NSString *)tag
               resolve:(void (^)(id result))resolve
                reject:(void (^)(NSString *code, NSString *message, NSError *_Nullable error))reject;

/**
 * Fetch if needed and resolve when {@p assetPackModelsPath} exists.
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

@end

NS_ASSUME_NONNULL_END
