import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Docker COPY inputs exist in a clean repository build context', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter((file) => file && existsSync(new URL(file, new URL('../../', import.meta.url))));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const copies = [...dockerfile.matchAll(/^COPY (?!.*--from=)(.+)$/gm)];
  assert.ok(copies.length > 0, 'The production Dockerfile must copy repository inputs');
  for (const [, instruction] of copies) {
    const paths = instruction.trim().split(/\s+/u).filter((part) => !part.startsWith('--'));
    for (const source of paths.slice(0, -1)) {
      const prefix = source.replace(/^\.\//u, '').replace(/\/$/u, '');
      if (prefix === '.') continue;
      assert.ok(files.some((file) => file === prefix || file.startsWith(`${prefix}/`)),
        `COPY source ${source} has no files in the clean repository context`);
    }
  }
});
