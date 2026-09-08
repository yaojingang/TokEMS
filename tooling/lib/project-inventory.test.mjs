import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectProjectInventory } from './project-inventory.mjs';

test('project inventory derives page, view, migration, table, API and test counts from source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokems-inventory-'));
  const files = {
    'apps/web/app/pages/index.vue': '<template />',
    'apps/web/app/pages/account/index.vue': '<template />',
    'apps/admin/src/views/UsersView.vue': '<template />',
    'apps/api/src/example.ts': `
      @Controller('examples')
      class ExampleController {
        @Get()
        list() {}
        @Post(':id')
        create() {}
      }
    `,
    'packages/database/drizzle/0000_initial.sql': '-- migration',
    'packages/database/src/schema.ts': `
      export const users = pgTable('users', {});
      export const events = pgTable('events', {});
    `,
    'packages/contracts/src/example.test.ts': 'test("works", () => {});',
    'apps/api/src/runtime.test.ts': `
      @Controller('test-only')
      class TestController {
        @Get()
        list() {}
      }
    `,
    'apps/api/src/runtime.spec.ts': `
      @Controller('spec-only')
      class SpecController {
        @Post()
        create() {}
      }
    `,
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }

  const inventory = await collectProjectInventory(root);

  assert.deepEqual(inventory, {
    schemaVersion: 1,
    webPages: 2,
    adminViews: 1,
    migrations: 1,
    latestMigration: '0000_initial.sql',
    databaseTables: 2,
    apiControllers: 1,
    apiOperations: 2,
    testFiles: 3,
  });
});
