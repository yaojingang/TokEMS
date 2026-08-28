import canonicalHomepageSnapshotData from './canonical-homepage.snapshot.json' with { type: 'json' };
import type {
  ConferenceTemplateDefinition,
  EventSettings,
  OrganizationSettings,
  PublicEvent,
  RegistrationField,
} from './index.js';

type CanonicalJsonRecord = Record<string, unknown>;

export type CanonicalHomepageSnapshot = {
  schemaVersion: 1;
  source: {
    organizationId: string;
    organizationSlug: string;
    eventId: number;
    eventSlug: string;
  };
  organization: {
    id: string;
    slug: string;
    name: string;
    settings: Omit<OrganizationSettings, 'analytics'>;
  };
  publicEvent: PublicEvent;
  template: {
    root: {
      id: string;
      code: string;
      name: string;
      description: string;
      tags: string[];
      status: string;
      currentPublishedVersionId: string | null;
    };
    version: {
      id: string;
      version: number;
      rendererPackageId: string;
      schemaVersion: number;
      definition: ConferenceTemplateDefinition;
      contentDigest: string;
      previewAssetKey: string | null;
      changeSummary: string;
    };
    publishedVersions: Array<{
      id: string;
      templateId: string;
      version: number;
      rendererPackageId: string;
      schemaVersion: number;
      definition: ConferenceTemplateDefinition;
      contentDigest: string;
      previewAssetKey: string | null;
      changeSummary: string;
    }>;
    releaseRoot: {
      id: string;
      code: string;
      name: string;
      description: string;
      tags: string[];
      status: string;
    } | null;
    draft: {
      rendererPackageId: string;
      schemaVersion: number;
      definition: ConferenceTemplateDefinition;
      revision: number;
      contentDigest: string;
    };
    binding: { updatePolicy: string; revision: number };
    renderer: {
      id: string;
      key: string;
      name: string;
      version: number;
      status: string;
      description: string;
      manifest: CanonicalJsonRecord;
    };
    renderers: Array<{
      id: string;
      key: string;
      name: string;
      version: number;
      status: string;
      description: string;
      manifest: CanonicalJsonRecord;
    }>;
    htmlDocuments: CanonicalJsonRecord[];
  };
  release: {
    id: string;
    version: number;
    templateKey: string;
    templateVersionId: string | null;
    snapshot: CanonicalJsonRecord;
    changeSummary: string;
    changeScope: string;
    activationKind: string;
  };
  backend: {
    event: CanonicalJsonRecord & {
      id: number;
      organizationId: string;
      slug: string;
      name: string;
      shortName: string;
      tagline: string;
      description: string;
      status: PublicEvent['status'];
      startsAt: string;
      endsAt: string;
      timezone: string;
      venue: string;
      city: string;
      address: string;
      settings: EventSettings;
    };
    ticketTypes: Array<
      CanonicalJsonRecord & {
        id: string;
        code: string;
        name: string;
        description: string;
        price: number;
        currency: string;
        capacity: number;
        active: boolean;
        recommended: boolean;
        benefits: string[];
      }
    >;
    registrationForm: CanonicalJsonRecord & {
      id: string;
      name: string;
      version: number;
      status: string;
      fields: RegistrationField[];
      termsVersion: string;
      termsContent: string;
    };
    speakers: CanonicalJsonRecord[];
    speakerRoutes: Array<CanonicalJsonRecord & { speakerId: string; publicCode: string }>;
    sessions: CanonicalJsonRecord[];
  };
  blueprint: (CanonicalJsonRecord & { id: string }) | null;
  blueprints: Array<CanonicalJsonRecord & { id: string }>;
  ticketQuotas: CanonicalJsonRecord[];
  checkinLists: CanonicalJsonRecord[];
  notificationTemplates: CanonicalJsonRecord[];
  aiPrompts: CanonicalJsonRecord[];
  assets: Array<
    CanonicalJsonRecord & {
      id: string;
      storageKey: string;
      mediaType: string;
      size: number;
      contentDigest: string;
      contentBase64: string;
    }
  >;
};

export const CANONICAL_HOMEPAGE_SNAPSHOT =
  canonicalHomepageSnapshotData as unknown as CanonicalHomepageSnapshot;
