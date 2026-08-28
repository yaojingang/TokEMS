import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
});
