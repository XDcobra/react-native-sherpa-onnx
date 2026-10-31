#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace sherpa_onnx {
namespace codec {

enum class Media { Video, Image, Audio };
enum class Direction { Decode, Encode };
enum class Use { Cpu, Display, Export };
enum class Tier { Hardware, Software, Unknown };
enum class Origin { Platform, Bundled };
enum class Policy { Hardware, Software, PreferHardware };
enum class RamClass { Low, Mid, High, VeryHigh };

enum class Reason {
  None,
  PoolFull,
  NotPresent,
  Disabled,
  OsTooOld,
  UnsupportedStream,
  ConfigureFailed,
  Reclaimed,
  InvalidSession,
  SwTooSlow
};

enum class ResourceClass {
  HwVideoDecodeCpu,
  HwVideoDecodeDisplay,
  HwVideoEncode,
  SwVideoDecode,
  SwVideoEncode,
  PlatformImageDecode
};

inline constexpr const char* kErrCodecInvalidArgument = "CODEC_INVALID_ARGUMENT";
inline constexpr const char* kErrVideoSwDecoderDisabled =
    "VIDEO_SW_DECODER_DISABLED";
inline constexpr const char* kErrVideoSwEncoderDisabled =
    "VIDEO_SW_ENCODER_DISABLED";
inline constexpr const char* kErrImageSwDecoderUnavailable =
    "ERR_IMAGE_SW_DECODER_UNAVAILABLE";
inline constexpr const char* kErrImageHwDecoderUnavailable =
    "ERR_IMAGE_HW_DECODER_UNAVAILABLE";
inline constexpr const char* kErrVideoDecoderUnavailable =
    "VIDEO_DECODER_UNAVAILABLE";
inline constexpr const char* kErrVideoEncoderUnavailable =
    "VIDEO_ENCODER_UNAVAILABLE";
inline constexpr const char* kErrPreviewDecoderBusy =
    "VIDEO_PREVIEW_DECODER_BUSY";

inline constexpr double kDefaultMeasuredFps1080Low = 45.0;
inline constexpr double kSwRealtimeMargin = 1.2;
inline constexpr int kRefWidth1080 = 1920;
inline constexpr int kRefHeight1080 = 1080;

struct Status {
  bool ok = true;
  std::string errorCode;
  std::string errorMessage;

  static Status Ok() { return {}; }
  static Status Fail(const char* code, std::string message) {
    Status s;
    s.ok = false;
    s.errorCode = code ? code : kErrCodecInvalidArgument;
    s.errorMessage = std::move(message);
    return s;
  }
};

template <typename T>
struct Result {
  Status status;
  T value{};
  bool ok() const { return status.ok; }
};

struct StreamCaps {
  std::string codec;
  int width = 0;
  int height = 0;
  int profile = -1;
  int bitDepth = 8;
  double fps = 0;
  int64_t bitrate = 0;
};

struct ProviderCaps {
  int minW = 0;
  int minH = 0;
  int maxW = 0;
  int maxH = 0;
  int widthAlign = 1;
  int heightAlign = 1;
  int64_t maxBlocks = 0;
  int64_t blockW = 16;
  int64_t blockH = 16;
  std::vector<int> profiles;
  int maxBitDepth = 8;
  int maxInstancesHint = 0;
  double measuredFps1080Low = 0;
};

struct Provider {
  Media media = Media::Video;
  Direction dir = Direction::Decode;
  std::string codec;
  Tier tier = Tier::Unknown;
  Origin origin = Origin::Platform;
  std::string name;
  ProviderCaps caps;
  bool available = true;
  Reason unavailableReason = Reason::None;
  int rank = 0;
};

struct Attempt {
  std::string provider;
  Tier tier = Tier::Unknown;
  Origin origin = Origin::Platform;
  Reason reason = Reason::None;
  std::string code;
};

struct Decision {
  Tier tier = Tier::Unknown;
  Origin origin = Origin::Platform;
  std::string provider;
  bool fellBack = false;
  Reason fallbackReason = Reason::None;
  std::string fallbackCode;
  std::vector<Attempt> attempts;
};

struct Request {
  Media media = Media::Video;
  Direction dir = Direction::Decode;
  Use use = Use::Cpu;
  StreamCaps stream;
  Policy policy = Policy::PreferHardware;
  std::string ownerKey;
};

struct PlanStep {
  const Provider* provider = nullptr;
  ResourceClass resource = ResourceClass::HwVideoDecodeCpu;
};

struct Plan {
  std::vector<PlanStep> steps;
  std::vector<Attempt> skipped;
};

struct PolicyConfig {
  Policy videoDecode = Policy::PreferHardware;
  Policy videoDisplay = Policy::PreferHardware;
  Policy videoEncode = Policy::PreferHardware;
  Policy imageDecode = Policy::PreferHardware;
};

struct SlotSnap {
  ResourceClass resource = ResourceClass::HwVideoDecodeCpu;
  int max = 1;
  int inUse = 0;
  const char* source = "auto";
};

const char* MediaName(Media m);
const char* DirectionName(Direction d);
const char* UseName(Use u);
const char* TierName(Tier t);
const char* OriginName(Origin o);
const char* PolicyName(Policy p);
const char* ReasonName(Reason r);
const char* ResourceName(ResourceClass c);
const char* ResourceJsName(ResourceClass c);
const char* RamClassName(RamClass r);

std::optional<Policy> ParsePolicy(const std::string& s);
std::optional<ResourceClass> ParseResourceJs(const std::string& s);
ResourceClass ResourceFor(const Request& req, Tier tier);
const char* ErrorCodeFor(const Request& req, Reason reason, Tier attempted);
std::string EscapeJson(const std::string& s);
std::string DecisionToJson(const Decision& d);

}  // namespace codec
}  // namespace sherpa_onnx
