import { createDatabase } from './index.js';
import { repairRegistrationIdentities } from './registration-identity-repair.js';

const apply = process.argv.includes('--apply');
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--' && argument !== '--apply');
if (unknownArguments.length) {
  throw new Error(`未知参数：${unknownArguments.join(' ')}`);
}

const { pool } = createDatabase();
try {
  if (!apply) console.info('报名身份归并预览（dry-run），数据库不会被修改。');
  process.exitCode = await repairRegistrationIdentities(pool, apply);
} finally {
  await pool.end();
}
