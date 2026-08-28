import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('pre-push validates the actual target commit and every canonical implementation file', async () => {
  const hook = await readFile('.githooks/pre-push', 'utf8');
  const protectedPaths = [
    'apps/api/src/common/database.service.ts',
    'apps/api/src/modules/public.module.ts',
    'packages/contracts/src/canonical-homepage.public.json',
    'packages/contracts/src/canonical-homepage.snapshot.json',
    'packages/database/src/export-canonical-homepage.ts',
    'packages/database/src/seed.ts',
  ];

  assert.match(hook, /push_updates=\$\(cat\)/u);
  assert.match(hook, /git diff --quiet "\$target_commit" -- "\$@"/u);
  assert.match(hook, /git diff --cached --quiet -- "\$@"/u);
  for (const path of protectedPaths) assert.match(hook, new RegExp(path.replaceAll('.', '\\.')));
});
