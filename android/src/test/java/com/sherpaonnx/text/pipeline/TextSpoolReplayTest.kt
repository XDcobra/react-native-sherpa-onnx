package com.sherpaonnx.text.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.zip.CRC32
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Regression tests for streaming STT → `fullIfSpooled` replay (checkpoint + journal).
 *
 * Bug class: [TextSpoolReplay.RECORD_PARTIAL_SET] carried only the unstable partial
 * window (~288 chars) and replaced a longer checkpoint (~1048 chars) during replay.
 */
class TextSpoolReplayTest {

  @Test
  fun partialRemainder_stripsAlreadyCommittedPrefix() {
    val remainder = TextSpoolReplay.partialRemainderFromCurrentText(
      currentText = "hello world again",
      lastCommittedSegmentText = "hello world",
    )
    assertEquals(" again", remainder)
  }

  @Test
  fun snapshotFullText_avoidsDoubleCountingCommittedTailInPartial() {
    val snapshot = TextSpoolReplay.snapshotFullText(
      committedSegmentText = "segment one segment two",
      currentText = "segment two partial tail",
      lastCommittedSegmentText = "segment two",
    )
    assertEquals("segment one segment two partial tail", snapshot)
  }

  @Test
  fun applyJournalRecord_partialSet_doesNotShrinkTranscript() {
    val checkpoint =
      "committed segments text that is much longer than any single partial hypothesis"
    val shortPartial = "partial only"

    val replayed = TextSpoolReplay.applyJournalRecord(
      checkpoint,
      TextSpoolReplay.RECORD_PARTIAL_SET,
      shortPartial,
    )

    assertEquals(checkpoint, replayed)
  }

  @Test
  fun applyJournalRecord_partialSet_replacesWhenPayloadIsLonger() {
    val baseline = "short"
    val longer = "short extended partial"

    val replayed = TextSpoolReplay.applyJournalRecord(
      baseline,
      TextSpoolReplay.RECORD_PARTIAL_SET,
      longer,
    )

    assertEquals(longer, replayed)
  }

  @Test
  fun applyJournalRecord_segmentCommit_appendsCommittedText() {
    val replayed = TextSpoolReplay.applyJournalRecord(
      "prefix",
      TextSpoolReplay.RECORD_SEGMENT_COMMIT,
      """{"text":" next"}""",
    )
    assertEquals("prefix next", replayed)
  }

  @Test
  fun replayFullText_matchesStreamingSttRegressionScenario() {
    val committed =
      "'S NEW MARK HOW IS YOUR NEW JOB GOING TO BE HONEST I CAN'T COMPLAIN " +
        "I REALLY LOVE THE COMPANY THAT I AM WORKING FOR MY CO WORKERS ARE ALL REALLY FRIENDLY"
    val shortPartial =
      "HOW IS YOUR NEW JOB GOING TO BE HONEST I CAN'T COMPLAIN"

    val checkpointPayload = TextSpoolReplay.buildCheckpointPayload(
      fullText = committed,
      totalCharsWritten = committed.length.toLong(),
      revision = 42,
    )

    val replayed = TextSpoolReplay.replayFullTextFromCheckpointAndJournal(
      checkpointPayload,
      listOf(
        TextSpoolJournalRecord(TextSpoolReplay.RECORD_PARTIAL_SET, shortPartial),
      ),
    )

    assertEquals(committed.length.toLong(), replayed.length.toLong())
    assertEquals(committed, replayed)
  }

  @Test
  fun replayFullText_readsCheckpointAndJournalFromDisk() {
    val dir = createTempDir(prefix = "txt_spool_replay_test_")
    val basePath = File(dir, "spool").absolutePath
    val committed = "alpha bravo charlie delta"
    val checkpointPayload = TextSpoolReplay.buildCheckpointPayload(
      fullText = committed,
      totalCharsWritten = committed.length.toLong(),
      revision = 1,
    )
    writeCheckpointFile("$basePath.txtc", checkpointPayload)
    writeJournalRecord(
      "$basePath.txtj",
      TextSpoolReplay.RECORD_PARTIAL_SET,
      "partial",
    )

    val replayed = TextSpoolReplay.replayFullTextFromCheckpointAndJournal(
      TextSpoolReader.readCheckpoint("$basePath.txtc"),
      TextSpoolReader.readJournal("$basePath.txtj"),
    )

    assertEquals(committed, replayed)
    dir.deleteRecursively()
  }

  private fun writeCheckpointFile(path: String, payload: String) {
    val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
    val checksum = CRC32().apply { update(payloadBytes) }.value.toInt()
    val header = ByteBuffer
      .allocate(16)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(0x32545854)
      .putShort(2)
      .putShort(4)
      .putInt(payloadBytes.size)
      .putInt(checksum)
      .array()
    File(path).outputStream().use { out ->
      out.write(header)
      out.write(payloadBytes)
    }
  }

  private fun writeJournalRecord(path: String, recordType: Int, payload: String) {
    val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
    val checksum = CRC32().apply { update(payloadBytes) }.value.toInt()
    val header = ByteBuffer
      .allocate(16)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(0x32545854)
      .putShort(2)
      .putShort(recordType.toShort())
      .putInt(payloadBytes.size)
      .putInt(checksum)
      .array()
    File(path).outputStream().use { out ->
      out.write(header)
      out.write(payloadBytes)
    }
  }
}
