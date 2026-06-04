#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * On-Demand Resources (ODR) for shipped model archives.
 * Tag names align with Android PAD pack names (e.g. core_models, studio_models).
 */
@interface SherpaOnnxOdrDelivery : NSObject

+ (instancetype)shared;

/** Models directory inside the bundle after the tag is available (…/TagName/models). */
- (nullable NSString *)assetPackModelsPath:(NSString *)tag;

- (BOOL)isTagReady:(NSString *)tag;

@end

NS_ASSUME_NONNULL_END
