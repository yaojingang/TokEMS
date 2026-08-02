import { describe, expect, it } from 'vitest';
import {
  mergeReleaseSnapshotForScope,
  releaseContentDigest,
  releaseSnapshotTemplateMetadata,
} from './event-release-activation.service.js';

describe('releaseContentDigest', () => {
  it('ignores operational timestamps, live inventory and the current release pointer', () => {
    const base = {
      event: {
        id: 101,
        name: '大会',
        updatedAt: '2026-08-02T08:00:00.000Z',
        settings: { currentReleaseId: 'release-a', registration: { registrationOpen: true } },
      },
      tickets: [{ id: 'ticket-a', name: '标准票', price: 100, sold: 2 }],
    };
    const operationallyNewer = {
      event: {
        ...base.event,
        updatedAt: '2026-08-02T09:00:00.000Z',
        settings: { ...base.event.settings, currentReleaseId: 'release-b' },
      },
      tickets: [{ ...base.tickets[0], sold: 8 }],
    };

    expect(releaseContentDigest(base)).toBe(releaseContentDigest(operationallyNewer));
    expect(releaseContentDigest(base)).not.toBe(
      releaseContentDigest({
        ...base,
        tickets: [{ ...base.tickets[0], price: 200 }],
      }),
    );
  });
});

describe('mergeReleaseSnapshotForScope', () => {
  const baseline = {
    event: {
      name: '回滚版大会',
      tagline: '回滚版主张',
      city: '上海',
      status: 'prepublished',
      settings: {
        registration: { registrationOpen: false },
        templateVersionId: 'template-old',
      },
    },
    tickets: [{ id: 'ticket-a', price: 100 }],
    speakers: [{ id: 'speaker-old' }],
    sessions: [{ id: 'session-old' }],
    registrationForm: { version: 1 },
    template: { key: 'renderer-old' },
    experience: {
      template: { versionId: 'template-old' },
      home: { title: '旧首页' },
      faq: { title: '旧 FAQ' },
      registrationFlow: { preset: 'standard' },
    },
  };
  const live = {
    event: {
      name: '编辑中大会',
      tagline: '新主张',
      city: '杭州',
      status: 'registration_open',
      settings: {
        registration: { registrationOpen: true },
        templateVersionId: 'template-new',
      },
    },
    tickets: [{ id: 'ticket-a', price: 200 }],
    speakers: [{ id: 'speaker-new' }],
    sessions: [{ id: 'session-new' }],
    registrationForm: { version: 2 },
    template: { key: 'renderer-new' },
    experience: {
      template: { versionId: 'template-new' },
      home: { title: '新首页' },
      faq: { title: '新 FAQ' },
      registrationFlow: { preset: 'quick' },
    },
  };

  it('updates event fields while preserving the active release modules', () => {
    const merged = mergeReleaseSnapshotForScope(baseline, live, 'event');

    expect(merged.event).toMatchObject({
      name: '编辑中大会',
      tagline: '新主张',
      city: '杭州',
      status: 'registration_open',
      settings: {
        registration: { registrationOpen: false },
        templateVersionId: 'template-old',
      },
    });
    expect(merged.tickets).toEqual(baseline.tickets);
    expect(merged.speakers).toEqual(baseline.speakers);
  });

  it('updates content while preserving event, ticket and form state', () => {
    const merged = mergeReleaseSnapshotForScope(baseline, live, 'content');

    expect(merged.event).toEqual(baseline.event);
    expect(merged.tickets).toEqual(baseline.tickets);
    expect(merged.registrationForm).toEqual(baseline.registrationForm);
    expect(merged.speakers).toEqual(live.speakers);
    expect(merged.sessions).toEqual(live.sessions);
  });

  it('updates only changed event fields after a rollback', () => {
    const merged = mergeReleaseSnapshotForScope(baseline, live, 'event', {
      eventFields: ['city'],
    });

    expect(merged.event).toMatchObject({
      name: baseline.event.name,
      tagline: baseline.event.tagline,
      city: live.event.city,
      status: baseline.event.status,
      settings: baseline.event.settings,
    });
  });

  it('updates one experience surface without reactivating a different live template', () => {
    const merged = mergeReleaseSnapshotForScope(baseline, live, 'experience', {
      experienceSurface: 'faq',
    });

    expect(merged.template).toEqual(baseline.template);
    expect(merged.event).toEqual(baseline.event);
    expect(merged.experience).toMatchObject({
      template: { versionId: 'template-old' },
      home: { title: '旧首页' },
      faq: { title: '新 FAQ' },
      registrationFlow: { preset: 'standard' },
    });
  });

  it('updates lifecycle registration together with the public status', () => {
    const merged = mergeReleaseSnapshotForScope(baseline, live, 'lifecycle', {
      registrationChanged: true,
    });

    expect(merged.event).toMatchObject({
      status: 'registration_open',
      settings: { registration: { registrationOpen: true } },
    });
    expect(merged.tickets).toEqual(baseline.tickets);
  });
});

describe('releaseSnapshotTemplateMetadata', () => {
  it('derives template identity and artifact type from the merged snapshot', () => {
    expect(
      releaseSnapshotTemplateMetadata(
        {
          event: { settings: { templateVersionId: 'stale-settings-version' } },
          template: { key: 'html-renderer' },
          experience: {
            template: { versionId: 'snapshot-version' },
            presentation: { kind: 'html' },
          },
        },
        { templateKey: 'live-renderer' },
      ),
    ).toEqual({
      templateKey: 'html-renderer',
      templateVersionId: 'snapshot-version',
      artifactExtension: 'html',
    });
  });

  it('preserves legacy release metadata when the snapshot lacks presentation fields', () => {
    expect(
      releaseSnapshotTemplateMetadata(
        { template: { key: 'legacy-renderer' }, experience: { faq: { items: [] } } },
        {
          templateKey: 'live-renderer',
          templateVersionId: 'legacy-version',
          currentArtifactKey: 'releases/event/v1/legacy.html',
        },
      ),
    ).toEqual({
      templateKey: 'legacy-renderer',
      templateVersionId: 'legacy-version',
      artifactExtension: 'html',
    });
  });
});
