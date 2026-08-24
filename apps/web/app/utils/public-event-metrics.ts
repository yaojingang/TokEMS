import type { PublicEventMetrics } from '@conference/contracts';

type PreviewQueryValue = string | Array<string | null> | null | undefined;

export function isPublicMetricsPreview(value: PreviewQueryValue) {
  return Array.isArray(value) ? value.includes('1') : value === '1';
}

export function shouldRecordPublicView(variant: string, preview: PreviewQueryValue) {
  return variant === 'live' && !isPublicMetricsPreview(preview);
}

export function createPublicViewRecorder<Result>(
  record: (slug: string, pageViewId: string) => Promise<Result>,
  createId: () => string = () => globalThis.crypto.randomUUID(),
) {
  const recordedSlugs = new Set<string>();
  return async (input: {
    slug: string;
    variant: string;
    preview: PreviewQueryValue;
  }): Promise<Result | undefined> => {
    if (!shouldRecordPublicView(input.variant, input.preview) || recordedSlugs.has(input.slug)) {
      return undefined;
    }
    recordedSlugs.add(input.slug);
    try {
      return await record(input.slug, createId());
    } catch {
      return undefined;
    }
  };
}

export function resolvePublicMetricFallbacks(
  metrics: PublicEventMetrics,
  fallback: { speakers: number; sessions: number },
) {
  return {
    organization: metrics.organizationCount
      ? { value: metrics.organizationCount, unit: '家', fallback: false }
      : { value: fallback.speakers, unit: '+', fallback: true },
    city: metrics.cityCount
      ? { value: metrics.cityCount, unit: '城', fallback: false }
      : { value: fallback.sessions, unit: '+', fallback: true },
  };
}

export function splitMetricNumber(value: number) {
  const formatted = Math.max(0, Math.trunc(value)).toLocaleString('zh-CN');
  return {
    prefix: formatted.slice(0, -1),
    lastDigit: formatted.slice(-1),
  };
}

export function offsetPublicMetric(value: number, configuredBase: string, fallbackBase = 10_000) {
  const parsedBase = Number.parseInt(configuredBase, 10);
  const base = Number.isFinite(parsedBase) && parsedBase >= 0 ? parsedBase : fallbackBase;
  return base + Math.max(0, Math.trunc(value));
}

export function formatTrackingStartDate(value: string | null, timeZone: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const month = read('month');
  const day = read('day');
  return month && day ? `${month}.${day}` : '';
}
