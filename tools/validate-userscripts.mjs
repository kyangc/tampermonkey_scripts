#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_URL = 'https://github.com/kyangc/tampermonkey_scripts';
const RAW_BASE_URL = 'https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main';
const USERSCRIPT_DIR = 'scripts';
const REQUIRED_FIELDS = [
  'name',
  'namespace',
  'version',
  'description',
  'author',
  'homepageURL',
  'supportURL',
  'updateURL',
  'downloadURL',
];

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  });
}

function parseMetadata(source) {
  const start = source.indexOf('// ==UserScript==');
  const end = source.indexOf('// ==/UserScript==');

  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const block = source.slice(start, end).split(/\r?\n/);
  const metadata = new Map();

  for (const line of block) {
    const match = line.match(/^\/\/\s+@(\S+)\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    const values = metadata.get(key) || [];
    values.push(value);
    metadata.set(key, values);
  }

  return metadata;
}

function first(metadata, key) {
  const values = metadata.get(key) || [];
  return values[0] || '';
}

function hasAny(metadata, keys) {
  return keys.some((key) => (metadata.get(key) || []).some((value) => value.trim()));
}

function validateFile(filePath) {
  const errors = [];
  const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join('/');
  const fileName = path.basename(filePath);
  const expectedRawUrl = `${RAW_BASE_URL}/${relativePath}`;
  const source = readFileSync(filePath, 'utf8');
  const metadata = parseMetadata(source);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.user\.js$/.test(fileName)) {
    errors.push('file name must use kebab-case.user.js');
  }

  if (!metadata) {
    errors.push('missing userscript metadata block');
    return errors;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!first(metadata, field)) {
      errors.push(`missing @${field}`);
    }
  }

  if (!hasAny(metadata, ['match', 'include'])) {
    errors.push('missing @match or @include');
  }

  const expectedFields = {
    namespace: REPO_URL,
    homepageURL: REPO_URL,
    supportURL: `${REPO_URL}/issues`,
    updateURL: expectedRawUrl,
    downloadURL: expectedRawUrl,
  };

  for (const [field, expected] of Object.entries(expectedFields)) {
    const actual = first(metadata, field);
    if (actual && actual !== expected) {
      errors.push(`@${field} must be ${expected}`);
    }
  }

  const version = first(metadata, 'version');
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push('@version must use x.y.z format');
  }

  return errors;
}

function main() {
  const userscriptRoot = path.join(process.cwd(), USERSCRIPT_DIR);
  const userscripts = walkFiles(userscriptRoot)
    .filter((filePath) => filePath.endsWith('.user.js'))
    .sort();

  if (userscripts.length === 0) {
    console.error(`No .user.js files found under ${USERSCRIPT_DIR}/`);
    process.exitCode = 1;
    return;
  }

  let errorCount = 0;

  for (const filePath of userscripts) {
    const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join('/');
    const errors = validateFile(filePath);

    if (errors.length === 0) {
      console.log(`ok ${relativePath}`);
      continue;
    }

    errorCount += errors.length;
    console.error(`error ${relativePath}`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
  }

  if (errorCount > 0) {
    console.error(`\n${errorCount} userscript convention error(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nValidated ${userscripts.length} userscript(s).`);
}

main();
