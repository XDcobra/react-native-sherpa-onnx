#import "VideoToolboxDecoder.h"

#include <gtest/gtest.h>

using sherpa_onnx::video::VideoCodec;
using sherpa_onnx::video::VideoToolboxDecoder;
using sherpa_onnx::video::VideoTrackInfo;

TEST(VideoToolbox, ConfigureWithoutAvccDoesNotCrash) {
  VideoToolboxDecoder dec;
  VideoTrackInfo track;
  track.codec = VideoCodec::H264;
  track.codedWidth = 16;
  track.codedHeight = 16;
  auto st = dec.Configure(track);
  EXPECT_FALSE(st.ok);
  EXPECT_FALSE(st.errorCode.empty());
  dec.Close();
}

TEST(VideoToolbox, HardwareHevcCheckDoesNotCrash) {
  VideoToolboxDecoder dec;
  VideoTrackInfo track;
  track.codec = VideoCodec::Hevc;
  track.codedWidth = 16;
  track.codedHeight = 16;
  auto st = dec.Configure(track);
  EXPECT_FALSE(st.errorCode.empty() || st.ok);
  dec.Close();
}
