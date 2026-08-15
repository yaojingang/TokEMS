const buildKeys = ['sha', 'builtAt', 'migration', 'migrationHash'];

export function assertBuildSourceState({ expectedSha, actualSha, status }) {
  if (actualSha !== expectedSha) {
    throw new Error('Git HEAD changed during the build or verification');
  }
  if (status.trim()) {
    throw new Error('Docker release builds require a clean Git worktree');
  }
  return actualSha;
}

export function assertBuildsConsistent(builds) {
  const entries = Object.entries(builds);
  if (entries.length === 0) throw new Error('no build metadata supplied');
  for (const [service, build] of entries) {
    if (!build || buildKeys.some((key) => !build[key] || build[key] === 'unknown')) {
      throw new Error(`${service} returned unknown build metadata`);
    }
    if (build.service !== service) {
      throw new Error(`${service} returned metadata for ${build.service ?? 'unknown service'}`);
    }
  }
  const expected = entries[0][1];
  for (const [service, build] of entries.slice(1)) {
    if (buildKeys.some((key) => build[key] !== expected[key])) {
      throw new Error(`${service} returned mixed build metadata`);
    }
  }
  return expected;
}
