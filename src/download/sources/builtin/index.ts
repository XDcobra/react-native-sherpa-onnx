import type { SourceProvider } from '../types';
import { githubK2FsaProvider } from './github-k2-fsa';
import { githubXdcobraProvider } from './github-xdcobra';
import {
  configureHuggingFaceSource,
  getHuggingFaceSourceConfig,
  huggingfaceProvider,
  type HuggingFaceRepoSpec,
  type HuggingFaceSourceConfig,
} from './huggingface';

export const BUILTIN_SOURCE_IDS = {
  GITHUB_K2_FSA: 'github_k2_fsa',
  GITHUB_XDCOBRA: 'github_xdcobra',
  HUGGINGFACE: 'huggingface',
} as const;

export type BuiltinSourceId =
  (typeof BUILTIN_SOURCE_IDS)[keyof typeof BUILTIN_SOURCE_IDS];

export const BUILTIN_GITHUB_PROVIDERS: SourceProvider[] = [
  githubK2FsaProvider,
  githubXdcobraProvider,
  huggingfaceProvider,
];

export {
  configureHuggingFaceSource,
  getHuggingFaceSourceConfig,
  githubK2FsaProvider,
  githubXdcobraProvider,
  huggingfaceProvider,
  type HuggingFaceRepoSpec,
  type HuggingFaceSourceConfig,
};
