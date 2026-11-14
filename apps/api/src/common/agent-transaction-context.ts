import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { auditLogs, type ConferenceDatabase } from '@conference/database';

export interface AgentTransactionContext {
  db: ConferenceDatabase;
  operationId: string;
  connectionId: string;
  delegatedUserId: string;
  traceId: string;
  auditIds: string[];
}

export const agentTransactionStorage = new AsyncLocalStorage<AgentTransactionContext>();

// Existing domain services join the operation transaction through DatabaseService.db.
// Audit inserts retain their domain action and resource while carrying the Agent identity.
export function agentTransactionDatabase(
  tx: object,
  context: Omit<AgentTransactionContext, 'db'>,
): ConferenceDatabase {
  const proxy = new Proxy(tx, {
    get(target, key) {
      if (key === 'transaction') {
        return async (callback: (db: ConferenceDatabase) => Promise<unknown>) => callback(proxy);
      }
      if (key === 'insert') {
        return (table: unknown) => {
          const builder = Reflect.apply(Reflect.get(target, key), target, [table]);
          if (table !== auditLogs) return builder;
          return new Proxy(builder as object, {
            get(insert, method) {
              if (method === 'values') {
                return (input: Record<string, unknown> | Record<string, unknown>[]) => {
                  const attach = (row: Record<string, unknown>) => {
                    if (row.resourceType === 'agent-operation') return row;
                    const id = typeof row.id === 'string' ? row.id : randomUUID();
                    context.auditIds.push(id);
                    return {
                      ...row,
                      id,
                      traceId: context.traceId,
                      actorId: context.connectionId,
                      actorType: 'agent',
                      before: {
                        ...((row.before as object) ?? {}),
                        agentOperationId: context.operationId,
                        delegatedUserId: context.delegatedUserId,
                      },
                    };
                  };
                  return Reflect.apply(Reflect.get(insert, method), insert, [
                    Array.isArray(input) ? input.map(attach) : attach(input),
                  ]);
                };
              }
              const value = Reflect.get(insert, method, insert);
              return typeof value === 'function' ? value.bind(insert) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ConferenceDatabase;
  return proxy;
}
