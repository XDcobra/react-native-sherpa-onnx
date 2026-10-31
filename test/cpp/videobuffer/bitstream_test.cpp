#include "demux/BitstreamUtil.h"

#include <gtest/gtest.h>

using sherpa_onnx::video::BitstreamUtil;
using sherpa_onnx::video::NalInfo;

TEST(BitstreamUtil, AvccAnnexBRoundTrip) {
  std::vector<uint8_t> avcc = {
      0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x03, 0x01, 0x9a, 0x02,
  };
  std::vector<uint8_t> annex;
  ASSERT_TRUE(BitstreamUtil::AvccToAnnexB(avcc.data(), avcc.size(), &annex).ok);
  ASSERT_TRUE(BitstreamUtil::LooksAnnexB(annex.data(), annex.size()));
  std::vector<uint8_t> back;
  ASSERT_TRUE(BitstreamUtil::AnnexBToAvcc(annex.data(), annex.size(), &back).ok);
  EXPECT_EQ(avcc, back);
}

TEST(BitstreamUtil, H264IdrIsKeyAndNonRef) {
  // AVCC: IDR nal type 5 with nal_ref_idc=3; then non-ref slice type 1 ref=0
  std::vector<uint8_t> idr = {0x00, 0x00, 0x00, 0x01, 0x65};
  NalInfo info = BitstreamUtil::InspectH264AccessUnit(idr.data(), idr.size(), true);
  EXPECT_TRUE(info.isKey);
  EXPECT_FALSE(info.isNonRef);

  std::vector<uint8_t> nref = {0x00, 0x00, 0x00, 0x01, 0x01};  // nal_ref_idc=0 type=1
  info = BitstreamUtil::InspectH264AccessUnit(nref.data(), nref.size(), true);
  EXPECT_FALSE(info.isKey);
  EXPECT_TRUE(info.isNonRef);
}

TEST(BitstreamUtil, AvcCSpsPps) {
  std::vector<uint8_t> avcc = {
      0x01, 0x64, 0x00, 0x1e, 0xff, 0xe1, 0x00, 0x03, 0x67, 0x42, 0xc0,
      0x01, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80,
  };
  std::vector<std::vector<uint8_t>> sps, pps;
  auto st = BitstreamUtil::ExtractH264ParameterSets(avcc, &sps, &pps);
  ASSERT_TRUE(st.ok) << st.errorMessage;
  ASSERT_EQ(sps.size(), 1u);
  ASSERT_EQ(pps.size(), 1u);
  EXPECT_EQ(sps[0].size(), 3u);
  EXPECT_EQ(pps[0].size(), 4u);

  sherpa_onnx::video::BitstreamUtil::AnnexBCsd csd;
  ASSERT_TRUE(
      BitstreamUtil::MakeAnnexBCsd(sherpa_onnx::video::VideoCodec::H264, avcc,
                                   &csd)
          .ok);
  ASSERT_EQ(csd.csd0.size(), 7u);
  ASSERT_EQ(csd.csd1.size(), 8u);
  EXPECT_EQ(csd.csd0[0], 0);
  EXPECT_EQ(csd.csd0[3], 1);
  EXPECT_EQ(csd.csd0[4], 0x67);
  EXPECT_EQ(csd.csd1[4], 0x68);
}

TEST(BitstreamUtil, HevcIrapIsKey) {
  // Annex-B IDR_W_RADL type 19: first byte (19 << 1) = 38
  std::vector<uint8_t> au = {0x00, 0x00, 0x00, 0x01, 0x26, 0x01};
  NalInfo info =
      BitstreamUtil::InspectHevcAccessUnit(au.data(), au.size(), false);
  EXPECT_TRUE(info.isKey);
}
