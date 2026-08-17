import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const skillDir = resolve(process.argv[2] || 'skills/tokems-admin');
const reportsDir = resolve(skillDir, 'reports');
const architecturePath = resolve(reportsDir, 'architecture_maintainability.json');
const architectureMarkdownPath = resolve(reportsDir, 'architecture_maintainability.md');
const skillIrPath = resolve(reportsDir, 'skill-ir.json');
const warnLines = 900;
const watchLines = 720;
const earlyWatchLines = 600;
const blockLines = 1500;

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const inventory = [];
for (const path of await filesUnder(resolve(skillDir, 'scripts'))) {
  const source = await readFile(path, 'utf8');
  const lines = source.split(/\r?\n/u).length;
  inventory.push({
    path: relative(skillDir, path),
    lines,
    test: path.endsWith('.test.mjs'),
    cli: path.endsWith('/tokems-admin.mjs'),
    command_handlers: path.endsWith('/tokems-admin.mjs')
      ? (source.match(/positionals\[[01]\]\s*===/gu) ?? []).length
      : 0,
  });
}

const sourceFiles = inventory.filter((item) => !item.test);
const testFiles = inventory.filter((item) => item.test);
const largestFiles = [...sourceFiles].sort((left, right) => right.lines - left.lines);
const watchlist = largestFiles.filter((item) => item.lines >= watchLines);
const earlyWatchlist = largestFiles.filter(
  (item) => item.lines >= earlyWatchLines && item.lines < watchLines,
);
const hotspots = largestFiles.filter((item) => item.lines >= warnLines);
const blockers = largestFiles.filter((item) => item.lines >= blockLines);
const architecture = JSON.parse(await readFile(architecturePath, 'utf8'));
architecture.ok = architecture.ok && blockers.length === 0;
architecture.summary = {
  ...architecture.summary,
  node_file_count: inventory.length,
  script_file_count: sourceFiles.length,
  test_file_count: testFiles.length,
  internal_module_count: sourceFiles.filter((item) => !item.cli).length,
  cli_script_count: sourceFiles.filter((item) => item.cli).length,
  command_handler_count: sourceFiles.reduce((sum, item) => sum + item.command_handlers, 0),
  entrypoint_command_handler_count: sourceFiles.reduce(
    (sum, item) => sum + item.command_handlers,
    0,
  ),
  warn_line_threshold: warnLines,
  watch_line_threshold: watchLines,
  early_watch_line_threshold: earlyWatchLines,
  block_line_threshold: blockLines,
  largest_file_lines: largestFiles[0]?.lines ?? 0,
  watchlist_count: watchlist.length,
  early_watchlist_count: earlyWatchlist.length,
  hotspot_count: hotspots.length,
  blocker_count: blockers.length,
  decision: blockers.length ? 'block' : hotspots.length ? 'warn' : 'pass',
};
architecture.largest_files = largestFiles.slice(0, 10);
architecture.watchlist = watchlist;
architecture.early_watchlist = earlyWatchlist;
architecture.hotspots = hotspots;
architecture.actions = [
  ...(architecture.actions ?? []),
  ...(hotspots.length
    ? hotspots.map((item) => ({
        path: item.path,
        action: 'Split the Node.js module before adding another responsibility.',
      }))
    : []),
];
architecture.runtime_inventory = {
  node: inventory,
  note: 'Repository-local Node.js augmentation; the upstream architecture scanner currently inventories Python.',
};
await writeFile(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`, 'utf8');
await writeFile(
  architectureMarkdownPath,
  `# Architecture maintainability\n\n` +
    `- Decision: \`${architecture.summary.decision}\`\n` +
    `- Node.js source modules: \`${sourceFiles.length}\`\n` +
    `- Node.js test modules: \`${testFiles.length}\`\n` +
    `- CLI command handlers: \`${architecture.summary.command_handler_count}\`\n` +
    `- Largest module: \`${largestFiles[0]?.path ?? 'none'}\` (${largestFiles[0]?.lines ?? 0} lines)\n` +
    `- Watchlist: \`${watchlist.length}\`; early watchlist: \`${earlyWatchlist.length}\`; blockers: \`${blockers.length}\`\n\n` +
    `## Node.js inventory\n\n` +
    `${largestFiles.map((item) => `- \`${item.path}\`: ${item.lines} lines`).join('\n')}\n\n` +
    `The repository-local augmentation inventories the required Node.js connector after the upstream Python-oriented audit.\n`,
  'utf8',
);

try {
  const skillIr = JSON.parse(await readFile(skillIrPath, 'utf8'));
  skillIr.risk = {
    ...(skillIr.risk ?? {}),
    execution_risk: 'high',
  };
  await writeFile(skillIrPath, `${JSON.stringify(skillIr, null, 2)}\n`, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

process.stdout.write(
  `${JSON.stringify({ ok: architecture.ok, sources: sourceFiles.length, tests: testFiles.length, largest: largestFiles[0] })}\n`,
);
if (!architecture.ok) process.exitCode = 1;
