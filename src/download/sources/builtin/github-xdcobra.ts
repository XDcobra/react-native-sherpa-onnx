import { getCategoryTag } from '../../paths';
import { ModelCategory } from '../../types';
import { DownloadError, DOWNLOAD_ERROR_CODES } from '../errors';
import { sourceFetch } from '../fetch';
import {
  buildSourceModelsFromGithubReleaseAssets,
  parseChecksumTxt,
} from '../github-common';
import type { SourceProvider } from '../types';

const DEFAULT_BASE =
  'https://api.github.com/repos/XDcobra/react-native-sherpa-onnx';

function makeTagUrl(baseUrl: string, tag: string): string {
  return `${baseUrl.replace(/\/$/, '')}/releases/tags/${tag}`;
}

function makeChecksumUrl(baseUrl: string, tag: string): string {
  const ownerAndRepo = baseUrl
    .replace(/^https:\/\/api\.github\.com\/repos\//, '')
    .replace(/\/$/, '');
  return `https://github.com/${ownerAndRepo}/releases/download/${tag}/checksum.txt`;
}

function getXdcobraCategoryTag(category: ModelCategory): string {
  if (category === ModelCategory.Alignment) {
    return 'alignment-models';
  }
  if (category === ModelCategory.Diarization) {
    return 'diarization-models';
  }
  return getCategoryTag(category);
}

export const githubXdcobraProvider: SourceProvider = {
  id: 'github_xdcobra',
  label: 'GitHub · XDcobra/react-native-sherpa-onnx',
  supportsCategory(category) {
    return (
      category === ModelCategory.Alignment ||
      category === ModelCategory.Diarization
    );
  },
  async listModels(category, ctx) {
    const tag = getXdcobraCategoryTag(category);
    const base = ctx.baseUrl ?? DEFAULT_BASE;
    const { response } = await sourceFetch(makeTagUrl(base, tag), ctx);

    const body = (await response.json()) as { assets?: unknown[] };
    const assets = Array.isArray(body.assets)
      ? (body.assets as Parameters<
          typeof buildSourceModelsFromGithubReleaseAssets
        >[1])
      : [];
    return buildSourceModelsFromGithubReleaseAssets(category, assets);
  },
  async getChecksums(category, ctx) {
    if (category === ModelCategory.Qnn) {
      return new Map<string, string>();
    }

    const tag = getXdcobraCategoryTag(category);
    const base = ctx.baseUrl ?? DEFAULT_BASE;
    let response: Response;
    try {
      response = (await sourceFetch(makeChecksumUrl(base, tag), ctx)).response;
    } catch (error) {
      if (
        error instanceof DownloadError &&
        error.code === DOWNLOAD_ERROR_CODES.SOURCE_AUTH_FAILED
      ) {
        throw error;
      }
      return undefined;
    }

    const text = await response.text();
    return parseChecksumTxt(text);
  },
  defaultHeaders() {
    return {
      Accept: 'application/vnd.github+json',
    };
  },
};
