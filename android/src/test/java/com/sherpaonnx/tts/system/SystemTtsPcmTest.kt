package com.sherpaonnx.tts.system

import org.junit.Assert.assertEquals
import org.junit.Test

class SystemTtsPcmTest {
  @Test
  fun floatArrayToPcm16_producesLittleEndianSamples() {
    val pcm = SystemTtsSynthesisController.floatArrayToPcm16(floatArrayOf(0f, 1f, -1f))
    assertEquals(6, pcm.size)
    assertEquals(0.toByte(), pcm[0])
    assertEquals(0.toByte(), pcm[1])
    assertEquals(0xFF.toByte(), pcm[2])
    assertEquals(0x7F.toByte(), pcm[3])
    assertEquals(0x01.toByte(), pcm[4])
    assertEquals(0x80.toByte(), pcm[5])
  }
}
