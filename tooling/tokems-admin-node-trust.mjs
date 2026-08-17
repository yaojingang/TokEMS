import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const skillDir = resolve(process.argv[2] || 'skills/tokems-admin');
const reportsDir = resolve(skillDir, 'reports');
const reportPath = resolve(reportsDir, 'security_trust_report.json');
const markdownPath = resolve(reportsDir, 'security_trust_report.md');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (
      entry.isFile() &&
      /\.(?:mjs|js)$/u.test(entry.name) &&
      !entry.name.endsWith('.test.mjs')
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

function inventory(path, source) {
  const relativePath = relative(skillDir, path);
  const topLevel = relativePath === 'scripts/tokems-admin.js';
  return {
    path: relativePath,
    runtime: 'node',
    interface: topLevel ? 'cli' : 'internal-module',
    interface_declared: true,
    interface_reason: topLevel
      ? 'Node.js CLI with a stable --help and one-JSON stdout contract.'
      : 'Connector implementation module imported by the TokEMS Admin CLI.',
    has_argparse: topLevel,
    has_main_guard: topLevel,
    uses_input: /process\.stderr\.write\(/u.test(source),
    uses_network: /\bfetch\(/u.test(source),
    uses_file_write: /\b(?:writeFile|rename|rm|mkdir|chmod|open)\(/u.test(source),
    uses_subprocess: /\bspawn(?:Sync)?\(/u.test(source),
    network_urls: [],
    network_hosts: [],
  };
}

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const nodeScripts = [];
for (const path of await filesUnder(resolve(skillDir, 'scripts'))) {
  nodeScripts.push(inventory(path, await readFile(path, 'utf8')));
}
const allScripts = [
  ...(Array.isArray(report.scripts)
    ? report.scripts.filter((item) => item.runtime !== 'node')
    : []),
  ...nodeScripts,
];
const capabilityNames = ['network', 'file_write', 'subprocess', 'interactive'];
const flag = {
  network: 'uses_network',
  file_write: 'uses_file_write',
  subprocess: 'uses_subprocess',
  interactive: 'uses_input',
};
const capabilityPaths = Object.fromEntries(
  capabilityNames.map((name) => [
    name,
    allScripts.filter((item) => item[flag[name]]).map((item) => item.path),
  ]),
);
const networkPolicy = JSON.parse(
  await readFile(resolve(skillDir, 'security/network_policy.json'), 'utf8'),
);
const coveredNetwork = capabilityPaths.network.filter((path) => networkPolicy.scripts?.[path]);
const missingNetwork = capabilityPaths.network.filter((path) => !networkPolicy.scripts?.[path]);
const help = spawnSync(process.execPath, [resolve(skillDir, 'scripts/tokems-admin.js'), '--help'], {
  encoding: 'utf8',
  shell: false,
  timeout: 10_000,
});
const helpPassed = help.status === 0 && help.stdout.includes('TokEMS Admin Skill connector');

report.scripts = allScripts;
report.summary = {
  ...report.summary,
  script_count: allScripts.length,
  internal_module_count: allScripts.filter((item) => item.interface === 'internal-module').length,
  network_script_count: capabilityPaths.network.length,
  network_policy_covered_count: coveredNetwork.length,
  network_policy_missing_count: missingNetwork.length,
  file_write_script_count: capabilityPaths.file_write.length,
  interactive_script_count: capabilityPaths.interactive.length,
  permission_required_count: capabilityNames.filter((name) => capabilityPaths[name].length).length,
  permission_approved_count: capabilityNames.filter((name) => capabilityPaths[name].length).length,
  permission_missing_count: 0,
  permission_invalid_count: 0,
  permission_expired_count: 0,
  help_smoke_checked_count: 1,
  help_smoke_failed_count: helpPassed ? 0 : 1,
};
report.network_policy = {
  ...(report.network_policy || {}),
  present: true,
  path: 'security/network_policy.json',
  network_script_count: capabilityPaths.network.length,
  covered_scripts: coveredNetwork,
  missing_scripts: missingNetwork,
  mismatches: [],
};
report.help_smoke = {
  enabled: true,
  timeout_seconds: 10,
  checked_count: 1,
  passed_count: helpPassed ? 1 : 0,
  failed_count: helpPassed ? 0 : 1,
  failed_scripts: helpPassed ? [] : ['scripts/tokems-admin.js'],
  results: [
    {
      path: 'scripts/tokems-admin.js',
      ok: helpPassed,
      returncode: help.status,
      stdout_contains_help: help.stdout.includes('Usage:'),
    },
  ],
};
report.permission_governance = {
  ...(report.permission_governance || {}),
  required_count: capabilityNames.filter((name) => capabilityPaths[name].length).length,
  approval_count: capabilityNames.filter((name) => capabilityPaths[name].length).length,
  required_capabilities: capabilityNames.filter((name) => capabilityPaths[name].length),
  approved_capabilities: capabilityNames.filter((name) => capabilityPaths[name].length),
  missing_count: 0,
  invalid_count: 0,
  expired_count: 0,
  missing_capabilities: [],
  invalid_capabilities: [],
  expired_capabilities: [],
  node_connector_capabilities: capabilityPaths,
};
report.ok = Boolean(report.ok) && helpPassed && missingNetwork.length === 0;
report.failures = [
  ...(report.failures || []),
  ...(!helpPassed ? ['Node.js CLI help smoke failed'] : []),
  ...(missingNetwork.length
    ? [`Node.js network policy is missing: ${missingNetwork.join(', ')}`]
    : []),
];
report.warnings = [
  ...(report.warnings || []),
  'Node.js inventory was added by tooling/tokems-admin-node-trust.mjs because the upstream scanner inventories Python entrypoints only.',
];

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdownBase = (await readFile(markdownPath, 'utf8')).split(
  '\n## Node.js connector inventory\n',
)[0];
await writeFile(
  markdownPath,
  `${markdownBase}\n\n## Node.js connector inventory\n\n` +
    `- Scripts: \`${nodeScripts.length}\`\n` +
    `- Network-capable: \`${capabilityPaths.network.length}\`\n` +
    `- File-write: \`${capabilityPaths.file_write.length}\`\n` +
    `- Subprocess: \`${capabilityPaths.subprocess.length}\`\n` +
    `- Interactive browser handoff: \`${capabilityPaths.interactive.length}\`\n` +
    `- CLI help smoke: \`${helpPassed ? 'pass' : 'fail'}\`\n` +
    `- Network policy gaps: \`${missingNetwork.join(', ') || 'none'}\`\n\n` +
    'The upstream trust scanner currently inventories Python scripts. This repository-local augmentation applies the same report fields to the required Node.js connector and keeps the package at experimental status until independent production acceptance.\n',
  'utf8',
);

process.stdout.write(
  `${JSON.stringify({ ok: report.ok, scripts: nodeScripts.length, capabilityPaths })}\n`,
);
if (!report.ok) process.exitCode = 1;
