import type { AudioOutputFormat } from 'react-native-sherpa-onnx/audio';
import type { FileDestination } from 'react-native-sherpa-onnx/fileio';

import {
  type AudioSourceChoice,
  type FileioInputChannelId,
  type FileioOperation,
  type FileioSampleSelection,
  runFileioCopy,
  runFileioDecode,
  runFileioProbe,
} from './fileioActions';
import {
  listAllSampleSelections,
  listAutomaticInputChannelIds,
  listFileioInputChannels,
  resolveFileioInputSource,
  type FileioInputSource,
} from './fileioInputChannels';

export type FileioBatchLineStatus =
  | 'success'
  | 'error'
  | 'canceled'
  | 'skipped';

export type FileioBatchLine = {
  sampleLabel: string;
  channelTitle: string;
  status: FileioBatchLineStatus;
  summary: string;
};

export type FileioBatchParams = {
  operation: FileioOperation;
  samples: FileioSampleSelection[];
  channelIds: FileioInputChannelId[];
  padPackName: string;
  destinationKind: FileDestination['kind'];
  audioSource: AudioSourceChoice;
  outputFormat: AudioOutputFormat;
};

function channelTitle(channelId: FileioInputChannelId): string {
  return (
    listFileioInputChannels().find((c) => c.id === channelId)?.title ??
    channelId
  );
}

function sampleTitle(selection: FileioSampleSelection): string {
  if (selection.kind === 'legacy') {
    return 'Legacy';
  }
  return selection.format.toUpperCase();
}

async function runOne(
  operation: FileioOperation,
  input: FileioInputSource,
  encode: {
    destinationKind: FileDestination['kind'];
    audioSource: AudioSourceChoice;
    outputFormat: AudioOutputFormat;
  }
): Promise<{ status: FileioBatchLineStatus; summary: string }> {
  if (operation === 'probe') {
    const result = await runFileioProbe(input);
    if (result.status === 'success') {
      return {
        status: 'success',
        summary: `${result.durationMs.toFixed(0)} ms, exact=${
          result.isExact ? 'yes' : 'no'
        }`,
      };
    }
    return { status: 'error', summary: result.message };
  }

  if (operation === 'decode') {
    const result = await runFileioDecode(input);
    if (result.status === 'success') {
      return {
        status: 'success',
        summary: `bufferId=${result.bufferId}, ${result.durationMs.toFixed(
          0
        )} ms`,
      };
    }
    return { status: 'error', summary: result.message };
  }

  const copyResult = await runFileioCopy({
    destinationKind: encode.destinationKind,
    audioSource: encode.audioSource,
    inputSource: input.fileSource,
    inputLabel: input.label,
    outputFormat: encode.outputFormat,
  });

  if (copyResult.status === 'canceled') {
    return { status: 'canceled', summary: 'Encode canceled (picker/dialog).' };
  }
  if (copyResult.status === 'success') {
    const firstLine = copyResult.detail.split('\n')[0] ?? copyResult.detail;
    return { status: 'success', summary: firstLine };
  }
  return { status: 'error', summary: copyResult.message };
}

export function buildFileioBatchMatrix(params: {
  batchAllSamples: boolean;
  batchAllChannels: boolean;
  currentSample: FileioSampleSelection;
  currentChannelId: FileioInputChannelId;
}): {
  samples: FileioSampleSelection[];
  channelIds: FileioInputChannelId[];
} {
  const samples = params.batchAllSamples
    ? listAllSampleSelections()
    : [params.currentSample];
  const channelIds = params.batchAllChannels
    ? listAutomaticInputChannelIds()
    : [params.currentChannelId];
  return { samples, channelIds };
}

/** Summary for the Active FileSource card when a batch toggle is on. */
export function describeFileioActiveInputSummary(params: {
  batchAllSamples: boolean;
  batchAllChannels: boolean;
  currentSample: FileioSampleSelection;
  currentChannelId: FileioInputChannelId;
  operation: FileioOperation;
}): { label: string; detail: string } {
  const { samples, channelIds } = buildFileioBatchMatrix(params);
  const runCount = samples.length * channelIds.length;

  const sampleNames = samples.map((s) => sampleTitle(s)).join(', ');
  const channelNames = channelIds.map((id) => channelTitle(id)).join(', ');

  let label: string;
  if (params.batchAllSamples && params.batchAllChannels) {
    label = `Batch: ${samples.length} samples × ${channelIds.length} channels (${runCount} runs)`;
  } else if (params.batchAllSamples) {
    label = `Batch: all samples via ${channelTitle(
      params.currentChannelId
    )} (${runCount} runs)`;
  } else {
    label = `Batch: ${sampleTitle(
      params.currentSample
    )} via all automatic channels (${runCount} runs)`;
  }

  const detailLines = [
    `Operation: ${params.operation}`,
    params.batchAllSamples
      ? `Samples: ${sampleNames}`
      : `Sample: ${sampleTitle(params.currentSample)}`,
    params.batchAllChannels
      ? `Channels: ${channelNames}`
      : `Channel: ${channelTitle(params.currentChannelId)}`,
  ];

  if (params.batchAllChannels) {
    detailLines.push(
      'Pick channels (contentUri / securityScoped) are excluded from batch.'
    );
  }

  if (params.batchAllSamples && !params.batchAllChannels) {
    const current = listFileioInputChannels().find(
      (c) => c.id === params.currentChannelId
    );
    if (current && !current.automatic) {
      detailLines.push(
        'Current channel is Pick — enable “Run all channels” or select an automatic channel before Run.'
      );
    }
  }

  return { label, detail: detailLines.join('\n') };
}

export async function runFileioBatch(
  params: FileioBatchParams
): Promise<{ lines: FileioBatchLine[]; text: string }> {
  const lines: FileioBatchLine[] = [];

  for (const selection of params.samples) {
    for (const channelId of params.channelIds) {
      const sLabel = sampleTitle(selection);
      const cTitle = channelTitle(channelId);

      let input: FileioInputSource;
      try {
        input = await resolveFileioInputSource({
          selection,
          channelId,
          padPackName: params.padPackName,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        lines.push({
          sampleLabel: sLabel,
          channelTitle: cTitle,
          status: 'error',
          summary: `Resolve failed: ${message}`,
        });
        continue;
      }

      try {
        const { status, summary } = await runOne(params.operation, input, {
          destinationKind: params.destinationKind,
          audioSource: params.audioSource,
          outputFormat: params.outputFormat,
        });
        lines.push({
          sampleLabel: sLabel,
          channelTitle: cTitle,
          status,
          summary,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        lines.push({
          sampleLabel: sLabel,
          channelTitle: cTitle,
          status: 'error',
          summary: message,
        });
      }
    }
  }

  const ok = lines.filter((l) => l.status === 'success').length;
  const fail = lines.filter((l) => l.status === 'error').length;
  const canceled = lines.filter((l) => l.status === 'canceled').length;
  const skipped = lines.filter((l) => l.status === 'skipped').length;

  const header = [
    `Batch ${params.operation} — ${params.samples.length} sample(s) × ${params.channelIds.length} channel(s)`,
    `OK ${ok} / FAIL ${fail}${canceled > 0 ? ` / CANCELED ${canceled}` : ''}${
      skipped > 0 ? ` / SKIPPED ${skipped}` : ''
    } / TOTAL ${lines.length}`,
    '',
  ].join('\n');

  const body = lines
    .map((line) => {
      const icon =
        line.status === 'success'
          ? '✓'
          : line.status === 'canceled'
          ? '○'
          : line.status === 'skipped'
          ? '−'
          : '✗';
      return `${icon} ${line.sampleLabel} · ${line.channelTitle}\n  ${line.summary}`;
    })
    .join('\n\n');

  return { lines, text: header + body };
}
