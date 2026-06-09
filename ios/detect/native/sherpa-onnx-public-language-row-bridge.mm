#import "sherpa-onnx-public-language-row-bridge.h"

namespace sherpaonnx {
namespace detect {
namespace bridge {

NSArray *PublicLanguageRowsToNSArray(
    const std::vector<PublicLanguageRow> &rows) {
  if (rows.empty()) {
    return nil;
  }
  NSMutableArray *languages = [NSMutableArray arrayWithCapacity:rows.size()];
  for (const auto &row : rows) {
    [languages addObject:@{
      @"iso6391Hint": [NSString stringWithUTF8String:row.iso6391Hint.c_str()] ?: @"",
      @"id": [NSString stringWithUTF8String:row.id.c_str()] ?: @"",
    }];
  }
  return languages;
}

}  // namespace bridge
}  // namespace detect
}  // namespace sherpaonnx
