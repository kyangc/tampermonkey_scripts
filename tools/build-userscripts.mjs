import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const bundles = [
  {
    output: 'scripts/make-x-great-again.user.js',
    sources: [
      'src/userscripts/make-x-great-again.entry.js',
      'src/userscripts/x-tweet-share-card.module.js',
    ],
  },
];

async function renderBundle(sources) {
  const parts = await Promise.all(
    sources.map((source) => readFile(resolve(repositoryRoot, source), 'utf8')),
  );
  return `${parts.map((part) => part.trimEnd()).join('\n\n')}\n`;
}

let failed = false;
for (const bundle of bundles) {
  const outputPath = resolve(repositoryRoot, bundle.output);
  const expected = await renderBundle(bundle.sources);
  if (!checkOnly) {
    await writeFile(outputPath, expected);
    console.log(`built ${bundle.output}`);
    continue;
  }

  let actual = '';
  try {
    actual = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (actual !== expected) {
    console.error(`${bundle.output} is stale; run npm run build:userscripts`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
