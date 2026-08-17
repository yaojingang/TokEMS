import { computed, ref } from 'vue';
import {
  type AccountProfile,
  type AcceptOrganizationInvitation,
  type AiGenerate,
  type AiRun,
  type AdminDashboard,
  type AdminDashboardQuery,
  type AdminOrderList,
  type AdminOrderListQuery,
  type AdminOrderRow,
  type AdminPreferences,
  type AdminRegistrationDetail,
  type AdminRegistrationOperationsDetail,
  type AdminRegistrationList,
  type AdminRegistrationListQuery,
  type AdminRegistrationRow,
  type AliyunSmsConfiguration,
  type AliyunSmsConnectionTest,
  type AuthMe,
  type CheckInRequest,
  type ConferenceTemplateDraft,
  type ConferenceTemplateOption,
  type ConferenceTemplateSummary,
  type ConferenceTemplateVersion,
  type CreateConferenceTemplate,
  type CreateCustomerAdmin,
  type CreateCustomerAdminResult,
  type CreateOrganizationAdministrator,
  type CreateRegistrationNote,
  type CreateOrganizationInvitation,
  type CreateOrganizationInvitationResult,
  type CreateEvent,
  type CustomerAdminDetail,
  type CustomerAdminExportQuery,
  type CustomerAdminList,
  type CustomerAdminListQuery,
  type DeleteCustomerAdminResult,
  type CustomerInvoiceList,
  type CustomerRegistrationList,
  type EventBlueprint,
  type EventContextOption,
  type EventExperience,
  type EventId,
  type EventRelease,
  type EventSlugAvailability,
  type EventSlugUpdateResult,
  type EventSummary,
  type EventTemplateBinding,
  type HtmlTemplateBindingManifest,
  type HtmlTemplateBindingProposal,
  type InvoiceAction,
  type InvoiceBatchPreflight,
  type InvoiceBatchPreflightResult,
  type InvoiceListQuery,
  type InvoiceRequest,
  type LoginResult,
  type MembershipStatus,
  type ModerateAttendeeShowcase,
  type NotificationTemplate,
  type OfflineCheckInSync,
  type OrganizationHomepageEvent,
  type OrganizationInvitation,
  type OrganizationMember,
  type OrganizationSettingsResult,
  type PublicEvent,
  type QueueNotification,
  type RegistrationCheckout,
  type RegistrationField,
  type RegistrationForm,
  type Refund,
  type RefundRequest,
  type ReviewRegistration,
  type TemplatePackage,
  type TemplateSurface,
  type TestAliyunSmsConfiguration,
  type UpdateAccountProfile,
  type UpdateAdminRegistrationAttendee,
  type UpdateAliyunSmsConfiguration,
  type UpdateCustomerAdmin,
  type UpdateEvent,
  type UpdateEventTemplateBinding,
  type UpdateOrganizationAdministrator,
  type UpdateOrganizationMember,
  type UpdateOrganizationSettings,
  type UpdateWeChatPayConfiguration,
  type WaitlistEntry,
  type WeChatPayConfiguration,
  type WeChatPayConnectionTest,
  publicEventHomePath,
  publicEventScopedPath,
} from '@conference/contracts';
import { adminOrderExportTable } from './order-export';
import {
  clearLegacyEventPreference,
  createEventOptionsLoader,
  createLatestPreferenceWriter,
  eventLandingRouteName,
  hasGrant,
  managementLandingRouteName,
  mergeEventContextOption,
  readRecentEventId,
  recentEventStorageKey,
  writeRecentEventId,
} from './admin-entry.js';
import { routeEventId } from './route-scope.js';

export type {
  AdminOrderRow,
  AdminRegistrationDetail,
  AdminRegistrationOperationsDetail,
  AdminRegistrationRow,
};

export interface CheckInResult {
  result: 'accepted' | 'duplicate' | 'invalid' | 'forbidden' | 'manual_review';
  ticket?: {
    code: string;
    attendeeName: string;
    ticketTypeName: string;
    status: string;
  };
  checkedInAt: string;
  message: string;
}

export interface TemplateAsset {
  id: string;
  storageKey: string;
  mediaType: string;
  size: number;
  width: number | null;
  height: number | null;
  contentDigest: string;
  altText: string;
  previewUrl: string | null;
  createdAt: string;
}

export interface HtmlTemplateImport {
  id: string;
  templateId: string | null;
  mode: 'create' | 'replace';
  status:
    | 'awaiting_upload'
    | 'queued'
    | 'scanning'
    | 'needs_review'
    | 'ready'
    | 'committed'
    | 'failed'
    | 'expired';
  originalFilename: string;
  sourceDigest: string | null;
  sourceSize: number | null;
  sanitizedDigest: string | null;
  nodeManifest: Array<{
    id: string;
    tagName: string;
    text: string;
    attributes: Record<string, string>;
    bindable: boolean;
  }>;
  assetManifest: Array<Record<string, unknown>>;
  securityReport: {
    removedTags?: string[];
    removedAttributes?: string[];
    warnings?: string[];
    blockers?: string[];
  };
  requestedMetadata: Record<string, unknown>;
  suggestions: HtmlTemplateBindingProposal[];
  committedTemplateId: string | null;
  committedDocumentId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HtmlTemplateDocumentDetail {
  id: string;
  templateId: string;
  originalFilename: string;
  sourceDigest: string;
  sourceSize: number;
  sanitizedHtml: string;
  sanitizedDigest: string;
  nodeManifest: HtmlTemplateImport['nodeManifest'];
  assetManifest: Array<Record<string, unknown>>;
  securityReport: HtmlTemplateImport['securityReport'];
  metadata: Record<string, unknown>;
  compilerVersion: number;
  bindings: HtmlTemplateBindingManifest;
  bindingDigest: string;
  revision: number;
  createdAt: string;
}

export interface HtmlTemplateVariableCatalog {
  version: number;
  ai: {
    enabled: boolean;
    configured: boolean;
    provider: string;
    model: string;
  };
  variables: Array<{
    path: string;
    label: string;
    category: string;
    type: string;
    description: string;
    formats: string[];
    required: boolean;
  }>;
}

const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
const token = ref(storage?.getItem('conference.admin.token') ?? '');
const user = ref<LoginResult['user'] | undefined>(
  JSON.parse(storage?.getItem('conference.admin.user') ?? 'null') as
    LoginResult['user'] | undefined,
);
const identity = ref<AuthMe>();
const activeEvent = ref<EventContextOption>();
const eventOptions = ref<EventContextOption[]>([]);
const entryNotice = ref('');
const recentEventRevision = ref(0);
let explicitEventRouteId: EventId | undefined;
const activeEventId = computed(() => activeEvent.value?.id);
const activeEventSlug = computed(() => activeEvent.value?.slug);

function eventPreferenceScope() {
  const currentIdentity = identity.value;
  if (!currentIdentity) return undefined;
  return {
    organizationId: currentIdentity.organization.id,
    publicUserId: currentIdentity.user.id,
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    const scope = eventPreferenceScope();
    if (scope && event.key === recentEventStorageKey(scope)) recentEventRevision.value += 1;
  });
}

function defaultPublicWebURL() {
  if (import.meta.env.DEV) return 'http://localhost:3000';
  const url = new URL(window.location.origin);
  if (url.hostname.startsWith('admin.')) url.hostname = url.hostname.slice('admin.'.length);
  return url.origin;
}
const publicWebURL = import.meta.env.VITE_PUBLIC_WEB_URL ?? defaultPublicWebURL();

export const session = {
  token,
  user,
  identity,
  authenticated: computed(() => Boolean(token.value)),
  activeEvent,
  activeEventId,
  activeEventSlug,
  eventOptions,
  entryNotice,
  recentEventRevision,
  set(result: LoginResult) {
    identity.value = undefined;
    activeEvent.value = undefined;
    eventOptions.value = [];
    eventOptionsLoader.invalidate();
    adminPreferenceWriter.reset();
    explicitEventRouteId = undefined;
    token.value = result.accessToken;
    user.value = result.user;
    storage?.setItem('conference.admin.token', result.accessToken);
    storage?.setItem('conference.admin.user', JSON.stringify(result.user));
  },
  setIdentity(value: AuthMe) {
    identity.value = value;
    clearLegacyEventPreference(storage);
  },
  syncAccountProfile(value: AccountProfile) {
    if (user.value) {
      user.value = {
        ...user.value,
        email: value.user.email,
        username: value.user.username,
        name: value.user.name,
        role: value.membership.role,
      };
      storage?.setItem('conference.admin.user', JSON.stringify(user.value));
    }
    if (identity.value) {
      identity.value = {
        ...identity.value,
        user: {
          id: value.user.id,
          email: value.user.email,
          username: value.user.username,
          name: value.user.name,
        },
        membership: {
          ...identity.value.membership,
          role: value.membership.role,
          grants: value.membership.grants,
          status: value.membership.status,
        },
      };
    }
  },
  can(required: string) {
    return hasGrant(identity.value?.membership.grants ?? [], required);
  },
  canAny(required: string[]) {
    return required.some((grant) => this.can(grant));
  },
  canAll(required: string[]) {
    return required.every((grant) => this.can(grant));
  },
  managementLandingRouteName() {
    return managementLandingRouteName(identity.value?.membership.grants ?? []);
  },
  landingRouteName() {
    return this.managementLandingRouteName();
  },
  eventLandingRouteName() {
    return eventLandingRouteName(identity.value?.membership.grants ?? []);
  },
  recentEventId() {
    void recentEventRevision.value;
    const scope = eventPreferenceScope();
    return scope ? readRecentEventId(storage, scope) : undefined;
  },
  forgetRecentEvent() {
    const scope = eventPreferenceScope();
    if (scope) {
      writeRecentEventId(storage, scope, undefined);
      recentEventRevision.value += 1;
    }
  },
  clearServerRecentEvent() {
    adminPreferenceWriter.schedule(null);
  },
  setRecentEventId(eventId: EventId | undefined) {
    const scope = eventPreferenceScope();
    if (scope) {
      writeRecentEventId(storage, scope, eventId);
      recentEventRevision.value += 1;
    }
  },
  async loadEventOptions() {
    const events = await eventOptionsLoader.load();
    eventOptions.value = events;
    return events;
  },
  invalidateEventOptions() {
    eventOptionsLoader.invalidate();
    eventOptions.value = [];
  },
  clear() {
    token.value = '';
    user.value = undefined;
    identity.value = undefined;
    activeEvent.value = undefined;
    eventOptions.value = [];
    eventOptionsLoader.invalidate();
    adminPreferenceWriter.reset();
    explicitEventRouteId = undefined;
    entryNotice.value = '';
    storage?.removeItem('conference.admin.token');
    storage?.removeItem('conference.admin.user');
  },
  setRuntimeEvent(event: EventContextOption | undefined) {
    activeEvent.value = event;
  },
  refreshRuntimeEvent(event: PublicEvent) {
    const current = activeEvent.value;
    if (!current || current.id !== event.id) return;
    activeEvent.value = mergeEventContextOption(current, event);
    if (event.status === 'archived' && this.recentEventId() === event.id) {
      this.forgetRecentEvent();
      this.clearServerRecentEvent();
      entryNotice.value = '当前大会已归档，已从最近大会中移除。';
    }
  },
  markExplicitEventRoute(eventId: EventId) {
    explicitEventRouteId = eventId;
  },
  consumeExplicitEventRoute(eventId: EventId) {
    const shouldRemember = explicitEventRouteId === eventId;
    explicitEventRouteId = undefined;
    return shouldRemember;
  },
  rememberEvent(event: EventContextOption) {
    activeEvent.value = event;
    if (event.status === 'archived') return;
    entryNotice.value = '';
    this.setRecentEventId(event.id);
    adminPreferenceWriter.schedule(event.id);
  },
};

function eventScope(eventId?: EventId): EventId {
  if (eventId) return eventId;
  const currentEventId =
    typeof window === 'undefined'
      ? undefined
      : routeEventId(window.location.pathname, import.meta.env.BASE_URL);
  if (!currentEventId) throw new Error('当前页面缺少明确的大会范围');
  return currentEventId;
}

export function publicHomepageUrl() {
  return new URL('/', publicWebURL).toString();
}

export function publicEventHomeUrl(eventSlug: string): string;
export function publicEventHomeUrl(eventSlug?: string): string | undefined;
export function publicEventHomeUrl(eventSlug = activeEventSlug.value): string | undefined {
  if (!eventSlug) return undefined;
  return new URL(publicEventHomePath(eventSlug), publicWebURL).toString();
}

export function publicEventPreviewUrl(eventSlug = activeEventSlug.value): string | undefined {
  const homeUrl = publicEventHomeUrl(eventSlug);
  if (!homeUrl) return undefined;
  const url = new URL(homeUrl);
  url.searchParams.set('preview', '1');
  return url.toString();
}

export function publicEventUrl(path = '/', eventSlug = activeEventSlug.value) {
  if (!eventSlug) return undefined;
  if (path === '/') return publicEventHomeUrl(eventSlug);
  if (path.startsWith('/#')) {
    const url = new URL(publicEventHomePath(eventSlug), publicWebURL);
    url.hash = path.slice(2);
    return url.toString();
  }
  return new URL(publicEventScopedPath(path, eventSlug), publicWebURL).toString();
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<unknown>>) {
  const escape = (value: unknown) => {
    const raw = String(value ?? '');
    const normalized = /^(?:\uFEFF)?[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
  };
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(',')).join('\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const baseURL =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV ? 'http://localhost:4100/api/v1' : '/api/v1');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session.token.value ? { Authorization: `Bearer ${session.token.value}` } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    if (response.status === 401) session.clear();
    throw new Error(body.message ?? `请求失败（${response.status}）`);
  }
  return body;
}

const eventOptionsLoader = createEventOptionsLoader(() =>
  request<EventContextOption[]>('/admin/event-options'),
);
const adminPreferenceWriter = createLatestPreferenceWriter(async (lastEventId) => {
  const currentIdentity = identity.value;
  const preferences = await request<AdminPreferences>('/auth/preferences/admin', {
    method: 'PATCH',
    body: JSON.stringify({ lastEventId }),
  });
  if (identity.value === currentIdentity && currentIdentity) {
    identity.value = { ...currentIdentity, adminPreferences: preferences };
  }
});

export const conferenceApi = {
  login(username: string, password: string, organizationSlug?: string) {
    return request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        ...(organizationSlug ? { organizationSlug } : {}),
      }),
    });
  },
  acceptInvitation(input: AcceptOrganizationInvitation) {
    return request<OrganizationMember>('/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getMe() {
    return request<AuthMe>('/auth/me');
  },
  updateAdminPreferences(lastEventId: EventId | null) {
    return request<AdminPreferences>('/auth/preferences/admin', {
      method: 'PATCH',
      body: JSON.stringify({ lastEventId }),
    });
  },
  getAccountProfile() {
    return request<AccountProfile>('/auth/profile');
  },
  updateAccountProfile(input: UpdateAccountProfile) {
    return request<AccountProfile>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  getDashboard(filters: AdminDashboardQuery = {}, eventId?: EventId) {
    const query = new URLSearchParams({ eventId: String(eventScope(eventId)) });
    if (filters.days) query.set('days', String(filters.days));
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    return request<AdminDashboard>(`/admin/dashboard?${query}`);
  },
  async getEvent(slug?: string, eventId?: EventId) {
    if (!slug) {
      return request<PublicEvent>(`/admin/events/${eventScope(eventId)}`);
    }
    const organizationSlug = session.identity.value?.organization.slug;
    return request<PublicEvent>(`/events/${slug}`, {
      ...(organizationSlug ? { headers: { 'X-Organization-Slug': organizationSlug } } : {}),
    });
  },
  async updateEvent(patch: UpdateEvent, eventId?: EventId) {
    const event = await request<PublicEvent>(`/admin/events/${eventScope(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    session.refreshRuntimeEvent(event);
    session.invalidateEventOptions();
    return event;
  },
  getRegistrations(filters: Partial<AdminRegistrationListQuery> = {}, eventId?: EventId) {
    const query = new URLSearchParams({ eventId: String(eventScope(eventId)) });
    if (filters.q) query.set('q', filters.q);
    if (filters.status) query.set('status', filters.status);
    if (filters.businessStatus) query.set('businessStatus', filters.businessStatus);
    if (filters.invoiceStatus) query.set('invoiceStatus', filters.invoiceStatus);
    if (filters.page) query.set('page', String(filters.page));
    if (filters.pageSize) query.set('pageSize', String(filters.pageSize));
    return request<AdminRegistrationList>(`/admin/registrations?${query}`);
  },
  getRegistration(registrationId: string, eventId?: EventId) {
    return request<AdminRegistrationDetail>(
      `/admin/events/${eventScope(eventId)}/registrations/${encodeURIComponent(registrationId)}`,
    );
  },
  getRegistrationOperations(registrationId: string, eventId?: EventId) {
    return request<AdminRegistrationOperationsDetail>(
      `/admin/events/${eventScope(eventId)}/registrations/${encodeURIComponent(registrationId)}/operations-detail`,
    );
  },
  updateRegistrationAttendee(
    registrationId: string,
    input: UpdateAdminRegistrationAttendee,
    eventId?: EventId,
  ) {
    return request<{ attendee: UpdateAdminRegistrationAttendee['attendee']; updatedAt: string }>(
      `/admin/events/${eventScope(eventId)}/registrations/${encodeURIComponent(registrationId)}/attendee`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  addRegistrationNote(registrationId: string, input: CreateRegistrationNote, eventId?: EventId) {
    return request<AdminRegistrationOperationsDetail['notes'][number]>(
      `/admin/events/${eventScope(eventId)}/registrations/${encodeURIComponent(registrationId)}/notes`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  getWaitlist(eventId?: EventId) {
    return request<WaitlistEntry[]>(`/admin/events/${eventScope(eventId)}/waitlist`);
  },
  reviewRegistration(registrationId: string, input: ReviewRegistration, eventId?: EventId) {
    return request<RegistrationCheckout>(
      `/admin/events/${eventScope(eventId)}/registrations/${registrationId}/review`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `registration-review-${crypto.randomUUID()}` },
        body: JSON.stringify(input),
      },
    );
  },
  getOrders(filters: Partial<AdminOrderListQuery> = {}, eventId?: EventId) {
    const query = new URLSearchParams({ eventId: String(eventScope(eventId)) });
    if (filters.q) query.set('q', filters.q);
    if (filters.status) query.set('status', filters.status);
    if (filters.page) query.set('page', String(filters.page));
    return request<AdminOrderList>(`/admin/orders?${query}`);
  },
  checkIn(payload: Omit<CheckInRequest, 'eventId' | 'checkInListId'>, eventId?: EventId) {
    return request<CheckInResult>('/checkins', {
      method: 'POST',
      headers: { 'Idempotency-Key': `checkin-${crypto.randomUUID()}` },
      body: JSON.stringify({
        ...payload,
        eventId: eventScope(eventId),
        checkInListId: 'main-entrance',
      }),
    });
  },
  getMembers() {
    return request<OrganizationMember[]>('/admin/organization/members');
  },
  getCustomers(query: CustomerAdminListQuery = { page: 1 }) {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    if (query.eventId) params.set('eventId', String(query.eventId));
    params.set('page', String(query.page));
    return request<CustomerAdminList>(`/admin/customers?${params}`);
  },
  async exportCustomers(query: CustomerAdminExportQuery = {}) {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    if (query.eventId) params.set('eventId', String(query.eventId));
    const response = await fetch(`${baseURL}/admin/customers/export.csv?${params}`, {
      headers: { Authorization: `Bearer ${session.token.value}` },
    });
    if (!response.ok) {
      if (response.status === 401) session.clear();
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? '用户数据导出失败');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'customers.csv';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    return Number(response.headers.get('x-export-row-count') ?? 0);
  },
  getCustomer(userId: number) {
    return request<CustomerAdminDetail>(`/admin/customers/${userId}`);
  },
  createCustomer(input: CreateCustomerAdmin) {
    return request<CreateCustomerAdminResult>('/admin/customers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getCustomerRegistrations(userId: number, cursor?: string, limit = 50) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return request<CustomerRegistrationList>(`/admin/customers/${userId}/registrations?${query}`);
  },
  getCustomerInvoices(userId: number, cursor?: string, limit = 50) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return request<CustomerInvoiceList>(`/admin/customers/${userId}/invoices?${query}`);
  },
  updateCustomer(userId: number, input: UpdateCustomerAdmin) {
    return request<CustomerAdminDetail>(`/admin/customers/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteCustomer(userId: number) {
    return request<DeleteCustomerAdminResult>(`/admin/customers/${userId}`, {
      method: 'DELETE',
    });
  },
  moderateAttendeeShowcase(eventId: EventId, showcaseId: string, input: ModerateAttendeeShowcase) {
    return request<{ updated: true }>(
      `/admin/events/${eventId}/member-showcases/${showcaseId}/moderation`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    );
  },
  updateMember(membershipId: string, input: UpdateOrganizationMember) {
    return request<OrganizationMember>(`/admin/organization/members/${membershipId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  updateMemberStatus(membershipId: string, status: MembershipStatus) {
    return request<OrganizationMember>(`/admin/organization/members/${membershipId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },
  removeMember(membershipId: string) {
    return request<{ deleted: boolean }>(`/admin/organization/members/${membershipId}`, {
      method: 'DELETE',
    });
  },
  getInvitations() {
    return request<OrganizationInvitation[]>('/admin/organization/invitations');
  },
  createAdministrator(input: CreateOrganizationAdministrator) {
    return request<OrganizationMember>('/admin/organization/administrators', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateAdministratorCredentials(membershipId: string, input: UpdateOrganizationAdministrator) {
    return request<OrganizationMember>(`/admin/organization/administrators/${membershipId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteAdministrator(membershipId: string) {
    return request<{ deleted: boolean }>(`/admin/organization/administrators/${membershipId}`, {
      method: 'DELETE',
    });
  },
  createInvitation(input: CreateOrganizationInvitation) {
    return request<CreateOrganizationInvitationResult>('/admin/organization/invitations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  cancelInvitation(invitationId: string) {
    return request<{ cancelled: boolean }>(`/admin/organization/invitations/${invitationId}`, {
      method: 'DELETE',
    });
  },
  getOrganizationSettings() {
    return request<OrganizationSettingsResult>('/admin/organization/settings');
  },
  updateOrganizationSettings(input: UpdateOrganizationSettings) {
    return request<OrganizationSettingsResult>('/admin/organization/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  getWeChatPayConfiguration() {
    return request<WeChatPayConfiguration>('/admin/integrations/wechat-pay');
  },
  updateWeChatPayConfiguration(input: UpdateWeChatPayConfiguration) {
    return request<WeChatPayConfiguration>('/admin/integrations/wechat-pay', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  testWeChatPayConfiguration() {
    return request<WeChatPayConnectionTest>('/admin/integrations/wechat-pay/test', {
      method: 'POST',
    });
  },
  getAliyunSmsConfiguration() {
    return request<AliyunSmsConfiguration>('/admin/integrations/aliyun-sms');
  },
  updateAliyunSmsConfiguration(input: UpdateAliyunSmsConfiguration) {
    return request<AliyunSmsConfiguration>('/admin/integrations/aliyun-sms', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  testAliyunSmsConfiguration(input: TestAliyunSmsConfiguration) {
    return request<AliyunSmsConnectionTest>('/admin/integrations/aliyun-sms/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': `aliyun-sms-test-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
  },
  getEvents() {
    return request<EventSummary[]>('/admin/events');
  },
  getEventOptions() {
    return session.loadEventOptions();
  },
  setOrganizationHomepageEvent(eventId: EventId) {
    return request<OrganizationHomepageEvent>('/admin/organization/homepage-event', {
      method: 'PUT',
      body: JSON.stringify({ eventId }),
    });
  },
  getEventSlugAvailability(slug: string, eventId?: EventId) {
    const query = new URLSearchParams({ slug });
    if (eventId) query.set('eventId', String(eventId));
    return request<EventSlugAvailability>(`/admin/event-slugs/availability?${query.toString()}`);
  },
  async updateEventSlug(eventId: EventId, slug: string) {
    const result = await request<EventSlugUpdateResult>(`/admin/events/${eventId}/public-url`, {
      method: 'PATCH',
      body: JSON.stringify({ slug }),
    });
    session.invalidateEventOptions();
    return result;
  },
  async createEvent(input: CreateEvent) {
    const event = await request('/admin/events', {
      method: 'POST',
      headers: { 'Idempotency-Key': `event-create-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
    session.invalidateEventOptions();
    return event;
  },
  getBlueprints() {
    return request<EventBlueprint[]>('/admin/event-blueprints');
  },
  getTemplates() {
    return request<TemplatePackage[]>('/admin/template-packages');
  },
  getConferenceTemplates() {
    return request<ConferenceTemplateSummary[]>('/admin/templates');
  },
  getHtmlTemplateVariableCatalog() {
    return request<HtmlTemplateVariableCatalog>('/admin/template-variable-catalog');
  },
  getHtmlTemplateImports() {
    return request<HtmlTemplateImport[]>('/admin/template-html-imports');
  },
  async uploadAndScanHtmlTemplate(
    file: File,
    input: {
      mode?: 'create' | 'replace';
      templateId?: string;
      name?: string;
      description?: string;
      tags?: string[];
      sourceUrl?: string;
    },
  ) {
    const bytes = await file.arrayBuffer();
    const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const sourceDigest = [...new Uint8Array(digestBuffer)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const prepared = await request<{
      import: HtmlTemplateImport;
      upload: { uploadUrl: string; headers: Record<string, string> };
    }>('/admin/template-html-imports', {
      method: 'POST',
      headers: { 'Idempotency-Key': `html-import-prepare-${crypto.randomUUID()}` },
      body: JSON.stringify({
        fileName: file.name,
        size: file.size,
        sourceDigest,
        mode: input.mode ?? 'create',
        ...(input.templateId ? { templateId: input.templateId } : {}),
        requestedMetadata: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        },
      }),
    });
    const upload = await fetch(prepared.upload.uploadUrl, {
      method: 'PUT',
      headers: prepared.upload.headers,
      body: new Blob([bytes], { type: 'text/html; charset=utf-8' }),
    });
    if (!upload.ok) throw new Error(`HTML 上传失败（${upload.status}）`);
    return request<HtmlTemplateImport>(`/admin/template-html-imports/${prepared.import.id}/scan`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `html-import-scan-${crypto.randomUUID()}` },
    });
  },
  getHtmlTemplateImport(importId: string) {
    return request<HtmlTemplateImport>(`/admin/template-html-imports/${importId}`);
  },
  retryHtmlTemplateImport(importId: string) {
    return request<HtmlTemplateImport>(`/admin/template-html-imports/${importId}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `html-import-retry-${crypto.randomUUID()}` },
    });
  },
  cancelHtmlTemplateImport(importId: string) {
    return request<HtmlTemplateImport>(`/admin/template-html-imports/${importId}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': `html-import-cancel-${crypto.randomUUID()}` },
    });
  },
  commitHtmlTemplateImport(
    importId: string,
    input: {
      revision?: number;
      bindings: HtmlTemplateBindingManifest;
      confirmWarnings: boolean;
      name?: string;
      description?: string;
      tags?: string[];
    },
  ) {
    return request<{ templateId: string; documentId: string }>(
      `/admin/template-html-imports/${importId}/commit`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `html-import-commit-${crypto.randomUUID()}` },
        body: JSON.stringify(input),
      },
    );
  },
  getHtmlTemplateDocument(templateId: string) {
    return request<HtmlTemplateDocumentDetail>(`/admin/templates/${templateId}/html-document`);
  },
  saveHtmlTemplateBindings(
    templateId: string,
    revision: number,
    bindings: HtmlTemplateBindingManifest,
  ) {
    return request<{
      revision: number;
      bindings: HtmlTemplateBindingManifest;
      bindingDigest: string;
      usedVariables: string[];
      requiredVariables: string[];
    }>(`/admin/templates/${templateId}/html-bindings`, {
      method: 'PUT',
      body: JSON.stringify({ revision, bindings }),
    });
  },
  createHtmlTemplatePreview(templateId: string) {
    return request<{
      previewUrl: string;
      expiresAt: string;
      revision: number;
      documentDigest: string;
      bindingDigest: string;
      channelId: string;
    }>(`/admin/templates/${templateId}/html-preview`, { method: 'POST' });
  },
  getHtmlTemplateAiRuns(templateId: string) {
    return request<
      Array<{
        id: string;
        templateId: string;
        status: string;
        provider: string;
        model: string;
        output: { proposals?: HtmlTemplateBindingProposal[] } | null;
        errorMessage: string | null;
        createdAt: string;
        completedAt: string | null;
      }>
    >(`/admin/templates/${templateId}/ai-variable-mappings`);
  },
  createHtmlTemplateAiRun(templateId: string) {
    return request<{
      id: string;
      status: string;
      output: { proposals?: HtmlTemplateBindingProposal[] } | null;
    }>(`/admin/templates/${templateId}/ai-variable-mappings`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `html-ai-create-${crypto.randomUUID()}` },
    });
  },
  applyHtmlTemplateAiProposals(templateId: string, runId: string, proposalIds: string[]) {
    return request(`/admin/templates/${templateId}/ai-variable-mappings/${runId}/apply`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `html-ai-apply-${crypto.randomUUID()}` },
      body: JSON.stringify({ proposalIds }),
    });
  },
  cancelHtmlTemplateAiRun(templateId: string, runId: string) {
    return request<{ id: string; status: string }>(
      `/admin/templates/${templateId}/ai-variable-mappings/${runId}/cancel`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `html-ai-cancel-${crypto.randomUUID()}` },
      },
    );
  },
  rejectHtmlTemplateAiRun(templateId: string, runId: string) {
    return request<{ id: string; status: string }>(
      `/admin/templates/${templateId}/ai-variable-mappings/${runId}/reject`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `html-ai-reject-${crypto.randomUUID()}` },
      },
    );
  },
  getTemplateOptions() {
    return request<ConferenceTemplateOption[]>('/admin/template-options');
  },
  createConferenceTemplate(input: CreateConferenceTemplate) {
    return request<{
      summary: ConferenceTemplateSummary;
      draft: ConferenceTemplateDraft;
      versions: ConferenceTemplateVersion[];
      usages: Array<Record<string, unknown>>;
    }>('/admin/templates', {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-create-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
  },
  getConferenceTemplate(templateId: string) {
    return request<{
      summary: ConferenceTemplateSummary;
      draft: ConferenceTemplateDraft;
      versions: ConferenceTemplateVersion[];
      usages: Array<Record<string, unknown>>;
    }>(`/admin/templates/${templateId}`);
  },
  saveConferenceTemplateDraft(
    templateId: string,
    input: { definition: ConferenceTemplateDraft['definition']; revision: number },
  ) {
    return request<ConferenceTemplateDraft>(`/admin/templates/${templateId}/draft`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  updateConferenceTemplate(
    templateId: string,
    input: {
      name?: string;
      description?: string;
      tags?: string[];
      revision: number;
    },
  ) {
    return request(`/admin/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  publishConferenceTemplate(templateId: string, revision: number, changeSummary: string) {
    return request<ConferenceTemplateVersion>(`/admin/templates/${templateId}/publish`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-publish-${crypto.randomUUID()}` },
      body: JSON.stringify({ revision, changeSummary }),
    });
  },
  duplicateConferenceTemplate(templateId: string, revision: number, name?: string) {
    return request(`/admin/templates/${templateId}/duplicate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-duplicate-${crypto.randomUUID()}` },
      body: JSON.stringify({ revision, ...(name ? { name } : {}) }),
    });
  },
  setConferenceTemplateArchived(templateId: string, revision: number, archived: boolean) {
    return request(`/admin/templates/${templateId}/${archived ? 'archive' : 'restore'}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-status-${crypto.randomUUID()}` },
      body: JSON.stringify({ revision }),
    });
  },
  getTemplateAssets() {
    return request<TemplateAsset[]>('/admin/template-assets');
  },
  async uploadTemplateAsset(
    file: File,
    altText: string,
    dimensions?: { width: number; height: number },
  ) {
    const digestBuffer = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const contentDigest = [...new Uint8Array(digestBuffer)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const prepared = await request<{
      uploadUrl: string;
      headers: Record<string, string>;
      storageKey: string;
    }>('/admin/template-assets/uploads', {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-asset-upload-${crypto.randomUUID()}` },
      body: JSON.stringify({
        fileName: file.name,
        mediaType: file.type,
        size: file.size,
        contentDigest,
        altText,
      }),
    });
    const uploaded = await fetch(prepared.uploadUrl, {
      method: 'PUT',
      headers: prepared.headers,
      body: file,
    });
    if (!uploaded.ok) throw new Error('模板图片上传失败，请重新选择文件');
    return request<TemplateAsset>('/admin/template-assets', {
      method: 'POST',
      headers: { 'Idempotency-Key': `template-asset-create-${crypto.randomUUID()}` },
      body: JSON.stringify({
        storageKey: prepared.storageKey,
        mediaType: file.type,
        size: file.size,
        contentDigest,
        altText,
        ...(dimensions ?? {}),
      }),
    });
  },
  deleteTemplateAsset(assetId: string) {
    return request<{ deleted: boolean; assetId: string }>(`/admin/template-assets/${assetId}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': `template-asset-delete-${crypto.randomUUID()}` },
    });
  },
  getTemplateBinding(eventId?: EventId) {
    return request<EventTemplateBinding>(`/admin/events/${eventScope(eventId)}/template-binding`);
  },
  updateTemplateBinding(input: UpdateEventTemplateBinding, eventId?: EventId) {
    return request<EventTemplateBinding>(`/admin/events/${eventScope(eventId)}/template-binding`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  getEventExperience(eventId?: EventId) {
    return request<EventExperience>(`/admin/events/${eventScope(eventId)}/experience`);
  },
  saveEventAsTemplate(
    input: {
      name: string;
      description: string;
      tags: string[];
      includeContent: boolean;
    },
    eventId?: EventId,
  ) {
    return request<{
      summary: ConferenceTemplateSummary;
      draft: ConferenceTemplateDraft;
      versions: ConferenceTemplateVersion[];
    }>(`/admin/events/${eventScope(eventId)}/save-as-template`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `event-save-template-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
  },
  saveEventExperience(
    surface: TemplateSurface,
    revision: number,
    document: Record<string, unknown>,
    eventId?: EventId,
  ) {
    return request<EventExperience>(`/admin/events/${eventScope(eventId)}/experience/${surface}`, {
      method: 'PUT',
      body: JSON.stringify({ revision, document }),
    });
  },
  validateEventExperience(eventId?: EventId) {
    return request<EventExperience['validation']>(
      `/admin/events/${eventScope(eventId)}/experience/validate`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  },
  getReleases(eventId?: EventId) {
    return request<EventRelease[]>(`/admin/events/${eventScope(eventId)}/releases`);
  },
  publishEvent(eventId?: EventId) {
    return request<EventRelease>(`/admin/events/${eventScope(eventId)}/releases`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  rollbackRelease(releaseId: string, eventId?: EventId) {
    return request<EventRelease>(
      `/admin/events/${eventScope(eventId)}/releases/${releaseId}/rollback`,
      { method: 'POST' },
    );
  },
  getContent(eventId?: EventId) {
    return request<{ speakers: PublicEvent['speakers']; sessions: Array<Record<string, unknown>> }>(
      `/admin/events/${eventScope(eventId)}/content`,
    );
  },
  createTicketType(
    input: {
      code: string;
      name: string;
      description: string;
      price: number;
      currency: string;
      capacity: number;
      recommended: boolean;
      benefits: string[];
    },
    eventId?: EventId,
  ) {
    return request(`/admin/events/${eventScope(eventId)}/ticket-types`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getArchivedTicketTypes(eventId?: EventId) {
    return request<
      Array<{ id: string; code: string; name: string; price: number; capacity: number }>
    >(`/admin/events/${eventScope(eventId)}/ticket-types/archived`);
  },
  restoreTicketType(ticketTypeId: string, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/ticket-types/${ticketTypeId}/restore`, {
      method: 'POST',
    });
  },
  updateTicketType(ticketTypeId: string, patch: Record<string, unknown>, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/ticket-types/${ticketTypeId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  deleteTicketType(ticketTypeId: string, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/ticket-types/${ticketTypeId}`, {
      method: 'DELETE',
    });
  },
  createSpeaker(
    input: Omit<PublicEvent['speakers'][number], 'id'> & { sortOrder?: number },
    eventId?: EventId,
  ) {
    return request(`/admin/events/${eventScope(eventId)}/speakers`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateSpeaker(
    speakerId: string,
    patch: Partial<PublicEvent['speakers'][number]>,
    eventId?: EventId,
  ) {
    return request(`/admin/events/${eventScope(eventId)}/speakers/${speakerId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  deleteSpeaker(speakerId: string, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/speakers/${speakerId}`, {
      method: 'DELETE',
    });
  },
  createSession(input: Record<string, unknown>, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/sessions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateSession(sessionId: string, patch: Record<string, unknown>, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  deleteSession(sessionId: string, eventId?: EventId) {
    return request(`/admin/events/${eventScope(eventId)}/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  },
  getForms(eventId?: EventId) {
    return request<RegistrationForm[]>(`/admin/events/${eventScope(eventId)}/registration-forms`);
  },
  publishForm(
    input: {
      name: string;
      fields: RegistrationField[];
      termsVersion: string;
      termsContent: string;
    },
    eventId?: EventId,
  ) {
    return request<RegistrationForm>(
      `/admin/events/${eventScope(eventId)}/registration-forms/publish`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  refundOrder(orderId: string, input: RefundRequest) {
    return request<Refund>(`/admin/orders/${orderId}/refunds`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `refund-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
  },
  getRefunds(eventId?: EventId) {
    return request<Refund[]>(`/admin/refunds?eventId=${eventScope(eventId)}`);
  },
  getInvoices(filters: InvoiceListQuery = {}, eventId?: EventId) {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) query.set(key, String(value));
    });
    return request<{ items: InvoiceRequest[]; nextCursor: string | null }>(
      `/admin/events/${eventScope(eventId)}/invoices?${query}`,
    );
  },
  getInvoice(invoiceId: string, eventId?: EventId) {
    return request<InvoiceRequest>(`/admin/events/${eventScope(eventId)}/invoices/${invoiceId}`);
  },
  getInvoicePendingCount(eventId?: EventId) {
    return request<{ count: number }>(
      `/admin/events/${eventScope(eventId)}/invoices/pending-count`,
    );
  },
  approveInvoice(invoiceId: string, expectedUpdatedAt: string, eventId?: EventId) {
    return request<InvoiceRequest>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/approve`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-approve-${crypto.randomUUID()}` },
        body: JSON.stringify({ expectedUpdatedAt }),
      },
    );
  },
  invoiceAction(
    invoiceId: string,
    action: 'reject' | 'retry' | 'issue-failed' | 'cancel',
    input: InvoiceAction,
    eventId?: EventId,
  ) {
    return request<InvoiceRequest>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/${action}`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-${action}-${crypto.randomUUID()}` },
        body: JSON.stringify(input),
      },
    );
  },
  addInvoiceDocument(
    invoiceId: string,
    input: {
      documentType: 'original' | 'adjustment' | 'reissue';
      invoiceNumber: string;
      invoiceCode?: string;
      externalReference?: string;
      storageKey: string;
      mediaType: 'application/pdf' | 'application/ofd';
      size: number;
      contentDigest: string;
      replacesDocumentId?: string;
    },
    eventId?: EventId,
  ) {
    return request<InvoiceRequest>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/documents`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-document-${crypto.randomUUID()}` },
        body: JSON.stringify(input),
      },
    );
  },
  prepareInvoiceDocumentUpload(
    invoiceId: string,
    input: {
      fileName: string;
      mediaType: 'application/pdf' | 'application/ofd';
      size: number;
      contentDigest: string;
      replaceDocumentId?: string;
    },
    eventId?: EventId,
  ) {
    return request<{
      uploadUrl: string;
      method: 'PUT';
      headers: Record<string, string>;
      storageKey: string;
      expiresAt: string;
    }>(`/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/document-uploads`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `invoice-upload-${crypto.randomUUID()}` },
      body: JSON.stringify(input),
    });
  },
  replaceInvoiceDocumentFile(
    invoiceId: string,
    documentId: string,
    input: {
      storageKey: string;
      mediaType: 'application/pdf' | 'application/ofd';
      size: number;
      contentDigest: string;
      reason: string;
      expectedUpdatedAt: string;
    },
    eventId?: EventId,
  ) {
    return request<InvoiceRequest>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/documents/${documentId}/replace-file`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-replace-file-${crypto.randomUUID()}` },
        body: JSON.stringify(input),
      },
    );
  },
  voidInvoiceDocument(
    invoiceId: string,
    documentId: string,
    reason: string,
    expectedUpdatedAt: string,
    eventId?: EventId,
  ) {
    return request<InvoiceRequest>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/documents/${documentId}/void`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-void-${crypto.randomUUID()}` },
        body: JSON.stringify({ reason, expectedUpdatedAt }),
      },
    );
  },
  sendInvoice(invoiceId: string, eventId?: EventId) {
    return request<{ queued: boolean }>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/send`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-send-${crypto.randomUUID()}` },
      },
    );
  },
  requestInvoiceDetailsReminder(invoiceId: string, eventId?: EventId) {
    return request<{ queued: boolean; alreadyQueued: boolean }>(
      `/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/details-reminder`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `invoice-details-reminder-${crypto.randomUUID()}` },
      },
    );
  },
  async downloadInvoiceDocument(
    invoiceId: string,
    documentId: string,
    fileName: string,
    eventId?: EventId,
  ) {
    const response = await fetch(
      `${baseURL}/admin/events/${eventScope(eventId)}/invoices/${invoiceId}/documents/${documentId}/download`,
      { headers: { Authorization: `Bearer ${session.token.value}` } },
    );
    if (!response.ok) throw new Error('下载电子发票失败');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  },
  async exportInvoices(filters: InvoiceListQuery = {}, eventId?: EventId) {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) query.set(key, String(value));
    });
    const scopedEventId = eventScope(eventId);
    const response = await fetch(
      `${baseURL}/admin/events/${scopedEventId}/invoices/export.csv?${query}`,
      {
        headers: {
          Authorization: `Bearer ${session.token.value}`,
          'Idempotency-Key': `invoice-export-${crypto.randomUUID()}`,
        },
      },
    );
    if (!response.ok) throw new Error('导出发票申请失败');
    let downloadResponse = response;
    let exportedRowCount = Number(response.headers.get('x-export-row-count') ?? 0);
    if (response.status === 202) {
      let job = (await response.json()) as {
        id: string;
        status: string;
        rowCount: number;
        downloadPath?: string;
        error?: string | null;
      };
      exportedRowCount = job.rowCount;
      let retried = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        job = await request<typeof job>(
          `/admin/events/${scopedEventId}/invoices/export-jobs/${job.id}`,
        );
        if (job.status === 'ready' && job.downloadPath) break;
        if (job.status === 'failed' && !retried) {
          retried = true;
          job = await request<typeof job>(
            `/admin/events/${scopedEventId}/invoices/export-jobs/${job.id}/retry`,
            {
              method: 'POST',
              headers: {
                'Idempotency-Key': `invoice-export-retry-${crypto.randomUUID()}`,
              },
            },
          );
        } else if (job.status === 'failed' || job.status === 'expired') {
          throw new Error(job.error || '导出任务失败，请重新发起');
        }
      }
      if (!job.downloadPath) throw new Error('导出任务仍在处理中，请稍后重试');
      downloadResponse = await fetch(`${baseURL}${job.downloadPath}`, {
        headers: { Authorization: `Bearer ${session.token.value}` },
      });
      if (!downloadResponse.ok) throw new Error('导出文件下载失败或链接已经过期');
    }
    const blob = await downloadResponse.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `invoice-requests-${scopedEventId}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    return exportedRowCount;
  },
  preflightInvoiceBatch(input: InvoiceBatchPreflight, eventId?: EventId) {
    return request<InvoiceBatchPreflightResult>(
      `/admin/events/${eventScope(eventId)}/invoices/batch-imports/preflight`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  getInventory(eventId?: EventId) {
    return request<
      Array<{
        id: string;
        name: string;
        capacity: number;
        sold: number;
        reserved: number;
        available: number;
      }>
    >(`/admin/events/${eventScope(eventId)}/inventory`);
  },
  getNotificationTemplates() {
    return request<NotificationTemplate[]>('/admin/notification-templates');
  },
  getNotificationDeliveries(eventId?: EventId) {
    return request<Array<Record<string, unknown>>>(
      `/admin/notification-deliveries?eventId=${eventScope(eventId)}`,
    );
  },
  queueNotification(input: QueueNotification) {
    return request('/admin/notifications/queue', {
      method: 'POST',
      body: JSON.stringify({ ...input, eventId: input.eventId ?? eventScope() }),
    });
  },
  getAiRuns(eventId?: EventId) {
    return request<AiRun[]>(`/admin/ai/runs?eventId=${eventScope(eventId)}`);
  },
  generateAiCopy(input: Omit<AiGenerate, 'eventId'>, eventId?: EventId) {
    return request<AiRun>('/admin/ai/generate', {
      method: 'POST',
      body: JSON.stringify({ ...input, eventId: eventScope(eventId) }),
    });
  },
  approveAiRun(runId: string) {
    return request<AiRun>(`/admin/ai/runs/${runId}/approve`, { method: 'POST' });
  },
  getDevices(eventId?: EventId) {
    return request<Array<Record<string, unknown>>>(
      `/admin/events/${eventScope(eventId)}/checkin-devices`,
    );
  },
  registerDevice(input: { deviceCode: string; name: string }, eventId?: EventId) {
    return request<{ device: Record<string, unknown>; token: string }>(
      `/admin/events/${eventScope(eventId)}/checkin-devices`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  syncOfflineCheckins(
    input: Omit<OfflineCheckInSync, 'eventId' | 'checkInListId'>,
    deviceToken: string,
    eventId?: EventId,
  ) {
    return request('/admin/checkins/sync', {
      method: 'POST',
      headers: { 'X-Device-Token': deviceToken },
      body: JSON.stringify({
        ...input,
        eventId: eventScope(eventId),
        checkInListId: 'main-entrance',
      }),
    });
  },
  getAuditLogs(eventId?: EventId) {
    return request<Array<Record<string, unknown>>>(
      `/admin/audit-logs?eventId=${eventScope(eventId)}`,
    );
  },
  async exportRegistrations(eventId?: EventId) {
    const scopedEventId = eventScope(eventId);
    const response = await fetch(
      `${baseURL}/admin/events/${scopedEventId}/registrations/export.csv`,
      { headers: { Authorization: `Bearer ${session.token.value}` } },
    );
    if (!response.ok) throw new Error('导出报名数据失败');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `registrations-${scopedEventId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  },
  exportOrders(rows: AdminOrderRow[]) {
    const table = adminOrderExportTable(rows);
    downloadCsv(
      `orders-${activeEventSlug.value ?? activeEventId.value ?? 'event'}-${new Date().toISOString().slice(0, 10)}.csv`,
      table.headers,
      table.rows,
    );
  },
};
