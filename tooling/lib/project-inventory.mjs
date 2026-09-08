import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const ignoredDirectories = new Set([
  '.git',
  '.nuxt',
  '.output',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
  'tmp',
]);

async function discoverFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await discoverFiles(root, path)));
    if (entry.isFile()) paths.push(relative(root, path));
  }
  return paths;
}

function within(path, directory) {
  return path.startsWith(`${directory}/`);
}

function matches(path, directory, pattern) {
  return within(path, directory) && pattern.test(path);
}

export async function collectProjectInventory(root, suppliedFiles) {
  const files = suppliedFiles ?? (await discoverFiles(root));
  const migrations = files
    .filter((path) => matches(path, 'packages/database/drizzle', /^.+\/\d{4}_.+\.sql$/u))
    .sort();
  const schemaPath = files.find((path) => path === 'packages/database/src/schema.ts');
  const schema = schemaPath ? await readFile(join(root, schemaPath), 'utf8') : '';
  const apiFiles = files.filter(
    (path) =>
      within(path, 'apps/api/src') &&
      /\.(?:ts|tsx)$/u.test(path) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(path),
  );
  const apiSource = (
    await Promise.all(apiFiles.map((path) => readFile(join(root, path), 'utf8')))
  ).join('\n');
  return {
    schemaVersion: 1,
    webPages: files.filter((path) => matches(path, 'apps/web/app/pages', /\.vue$/u)).length,
    adminViews: files.filter((path) => matches(path, 'apps/admin/src/views', /\.vue$/u)).length,
    migrations: migrations.length,
    latestMigration: migrations.length > 0 ? basename(migrations.at(-1)) : 'unknown',
    databaseTables: [...schema.matchAll(/\bpgTable\s*\(/gu)].length,
    apiControllers: [...apiSource.matchAll(/@Controller\s*\(/gu)].length,
    apiOperations: [...apiSource.matchAll(/@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/gu)]
      .length,
    testFiles: files.filter((path) => /(?:^|\/)\w[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path))
      .length,
  };
}
