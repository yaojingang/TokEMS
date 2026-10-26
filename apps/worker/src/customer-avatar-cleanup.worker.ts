import { customerMediaAssets, type ConferenceDatabase } from '@conference/database';
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';

type SourceDeletionUrl = (storageKey: string, method: 'DELETE') => string | null;

export async function cleanupExpiredCustomerAvatarSources(
  db: ConferenceDatabase,
  objectStorageUrl: SourceDeletionUrl,
) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const assets = await db
    .select()
    .from(customerMediaAssets)
    .where(
      and(
        or(
          isNull(customerMediaAssets.outputStorageKey),
          ne(customerMediaAssets.sourceStorageKey, customerMediaAssets.outputStorageKey),
        ),
        or(
          and(
            inArray(customerMediaAssets.status, ['processing', 'failed']),
            isNull(customerMediaAssets.confirmedAt),
            isNull(customerMediaAssets.sourceDeletedAt),
            lt(customerMediaAssets.createdAt, cutoff),
          ),
          and(
            eq(customerMediaAssets.status, 'ready'),
            isNotNull(customerMediaAssets.outputStorageKey),
            ne(customerMediaAssets.outputStorageKey, ''),
            isNull(customerMediaAssets.sourceDeletedAt),
          ),
        ),
      ),
    )
    .orderBy(asc(customerMediaAssets.createdAt))
    .limit(100);
  for (const asset of assets) {
    // Imported media can use one stored object for both the source and display image.
    if (
      asset.sourceStorageKey === asset.outputStorageKey ||
      (asset.status === 'ready' && !asset.outputStorageKey)
    )
      continue;
    const expiredUnconfirmed = !asset.confirmedAt && asset.status !== 'ready';
    if (expiredUnconfirmed) {
      const [claimed] = await db
        .update(customerMediaAssets)
        .set({
          status: 'failed',
          failureReason: `${asset.failureReason ?? '头像上传已过期'} [cleanup-claimed]`.slice(
            0,
            2_000,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customerMediaAssets.id, asset.id),
            isNull(customerMediaAssets.confirmedAt),
            isNull(customerMediaAssets.sourceDeletedAt),
            lt(customerMediaAssets.createdAt, cutoff),
          ),
        )
        .returning({ id: customerMediaAssets.id });
      if (!claimed) continue;
    }
    const url = objectStorageUrl(asset.sourceStorageKey, 'DELETE');
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok && response.status !== 404) continue;
      await db
        .update(customerMediaAssets)
        .set({
          ...(expiredUnconfirmed
            ? {
                failureReason: `${asset.failureReason ?? '头像上传已过期'} [source-cleaned]`.slice(
                  0,
                  2_000,
                ),
              }
            : {}),
          sourceDeletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(customerMediaAssets.id, asset.id));
    } catch (error) {
      console.warn(
        `[avatar] expired source cleanup failed asset=${asset.id}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
