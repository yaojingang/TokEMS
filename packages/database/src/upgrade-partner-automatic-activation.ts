import { createDatabase } from './index.js';
import { upgradePartnerAutomaticActivation } from './partner-automatic-activation.js';

const args = process.argv.slice(2).filter(value => value !== '--');
if (args.some(value => value !== '--apply')) throw new Error('Supported argument: --apply');
const { pool } = createDatabase();
try {
  console.info(JSON.stringify(await upgradePartnerAutomaticActivation(pool, args.includes('--apply')), null, 2));
} finally {
  await pool.end();
}
