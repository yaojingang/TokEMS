import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicEventViewResult, RecordPublicEventView } from '@conference/contracts';
import { ConferenceRepository } from './conference.repository.js';
import { RedisService } from './redis.service.js';

const KNOWN_BOT_USER_AGENT =
  /(?:bot|crawler|spider|slurp|bingpreview|facebookexternalhit|facebookcatalog|google-inspectiontool|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot|whatsapp|telegrambot|twitterbot|yandex|baiduspider|bytespider|petalbot|semrushbot|ahrefsbot)/iu;

export function isKnownBotUserAgent(userAgent: string | undefined) {
  return Boolean(userAgent && KNOWN_BOT_USER_AGENT.test(userAgent));
}

@Injectable()
export class EventPublicMetricsService {
  private readonly logger = new Logger(EventPublicMetricsService.name);
  private redisFallbackLogged = false;

  constructor(
    @Inject(ConferenceRepository) private readonly repository: ConferenceRepository,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async recordView(
    slug: string,
    organizationSlug: string,
    input: RecordPublicEventView,
    userAgent: string | undefined,
  ): Promise<PublicEventViewResult> {
    const event = await this.repository.getPublicEvent(slug, organizationSlug);
    if (isKnownBotUserAgent(userAgent)) {
      return this.repository.getPublicEventViewResult(event.id, event.organizationId);
    }

    let acceptedByRedis = true;
    try {
      const result = await this.redis
        .getClient()
        .set(`public-metrics:view:${event.id}:${input.pageViewId}`, '1', 'EX', 600, 'NX');
      acceptedByRedis = result === 'OK';
    } catch {
      if (!this.redisFallbackLogged) {
        this.redisFallbackLogged = true;
        this.logger.warn(
          'Redis unavailable for public metric idempotency; using database fallback',
        );
      }
    }

    if (!acceptedByRedis) {
      return this.repository.getPublicEventViewResult(event.id, event.organizationId);
    }
    return this.repository.recordPublicEventView(event.id, event.organizationId);
  }
}
