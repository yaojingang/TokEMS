import { describe, expect, it } from 'vitest';
import { eventSettingsEffectDescription } from './event-settings-effect';

describe('event registration settings effect copy', () => {
  it('distinguishes live events from events that have not launched', () => {
    expect(eventSettingsEffectDescription('registration_open')).toBe(
      '当前大会已上线，保存后前台立即生效。',
    );
    expect(eventSettingsEffectDescription('draft')).toBe(
      '当前大会尚未上线，保存内容将在大会上线时生效。',
    );
  });
});
