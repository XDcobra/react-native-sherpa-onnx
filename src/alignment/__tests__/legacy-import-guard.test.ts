import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function collectCodeFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const out: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCodeFiles(absPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      out.push(absPath);
    }
  }

  return out;
}

function findForbiddenImports(source: string): string[] {
  const matches: string[] = [];

  const importRegex =
    /import\s+(?!type\b)(?:[^;\n]*?)\balignTextToAudio\b(?:[^;\n]*?)from\s*['"]react-native-sherpa-onnx['"]/g;
  const requireRegex =
    /(?:const|let|var)\s*\{[^}]*\balignTextToAudio\b[^}]*\}\s*=\s*require\(\s*['"]react-native-sherpa-onnx['"]\s*\)/g;

  for (const match of source.matchAll(importRegex)) {
    matches.push(match[0]);
  }
  for (const match of source.matchAll(requireRegex)) {
    matches.push(match[0]);
  }

  return matches;
}

describe('alignment legacy import guard', () => {
  it('blocks value imports of alignTextToAudio from react-native-sherpa-onnx outside src/alignment', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const roots = [
      path.join(repoRoot, 'src'),
      path.join(repoRoot, 'example', 'src'),
    ];
    const codeFiles = roots.flatMap(collectCodeFiles);

    const violations: string[] = [];

    for (const absPath of codeFiles) {
      const relPath = path
        .relative(repoRoot, absPath)
        .split(path.sep)
        .join('/');

      if (relPath.startsWith('src/alignment/')) {
        continue;
      }

      const source = fs.readFileSync(absPath, 'utf8');
      const forbidden = findForbiddenImports(source);
      if (forbidden.length === 0) {
        continue;
      }

      for (const clause of forbidden) {
        violations.push(`${relPath}: ${clause}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
