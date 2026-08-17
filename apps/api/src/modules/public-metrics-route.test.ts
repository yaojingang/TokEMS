import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { EventsController } from './public.module.js';

describe('public metric route policy', () => {
  it('limits each client IP to 30 view registrations per minute', () => {
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', EventsController.prototype.recordPublicView),
    ).toBe(30);
    expect(
      Reflect.getMetadata('THROTTLER:TTLdefault', EventsController.prototype.recordPublicView),
    ).toBe(60_000);
  });
});
