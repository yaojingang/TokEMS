import type { AdminPartnerRelationshipView } from '@conference/contracts';
import { zipSync } from 'fflate';
import { boundedPosterFilename } from '@conference/ui/posters';

export function partnerPosterUnavailableReason(item: AdminPartnerRelationshipView) {
  if (item.promotionUnavailableReason) return item.promotionUnavailableReason;
  if (item.qualificationStatus === 'paused') return '合作伙伴已暂停，当前推广链接不可用。';
  if (item.qualificationStatus === 'closed') return '合作伙伴已关闭，当前推广链接不可用。';
  if (item.qualificationStatus !== 'active') return '合作伙伴尚未启用。';
  if (!item.attributionEnabled) return '推广归因尚未开通，请启用推广。';
  if (!item.referralPath) return '尚无推广链接，请启用推广以补全链接。';
  return '';
}

export function savePosterFile(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function partnerPosterArchive(files: Array<{ blob: Blob; filename: string }>) {
  if (!files.length) throw new Error('没有可下载的海报。');
  const entries: Record<string, Uint8Array> = {};
  for (const [index, file] of files.entries()) {
    const safe = file.filename.replace(/[\\/\p{Cc}]/gu, '-');
    const filename = boundedPosterFilename(safe.replace(/\.png$/iu, ''));
    entries[`${String(index + 1).padStart(3, '0')}-${filename}`] = new Uint8Array(await file.blob.arrayBuffer());
  }
  // PNG data is already compressed; stored ZIP entries avoid recompressing each poster.
  const archive = zipSync(entries, { level: 0 });
  return new Blob([new Uint8Array(archive).buffer], { type: 'application/zip' });
}
