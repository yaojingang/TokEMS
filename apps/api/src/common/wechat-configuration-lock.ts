import { sql } from 'drizzle-orm';
import type { DatabaseService } from './database.service.js';

type Database = NonNullable<DatabaseService['db']>;
export type WeChatConfigurationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Configuration mutations and new refund obligations lock the organization before any order. */
export async function lockWeChatConfiguration(
  tx: WeChatConfigurationTransaction,
  organizationId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wechat-configuration:${organizationId}`}, 0))`,
  );
}
