import { isPublicEventStatus, type EventStatus } from '@conference/contracts';

export function eventSettingsEffectDescription(status: EventStatus | undefined) {
  return status && isPublicEventStatus(status)
    ? '当前大会已上线，保存后前台立即生效。'
    : '当前大会尚未上线，保存内容将在大会上线时生效。';
}
