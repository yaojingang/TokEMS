import {
  DEMO_EVENT,
  type CreateRegistration,
  type CustomerOrderAccess,
  type Order,
  type PublicSiteConfiguration,
  type PublicEvent,
  type PublicEventViewResult,
  type PublicEventMemberDetail,
  type PublicEventMemberList,
  type RegistrationCheckout,
  type SubmitInvoiceDetails,
  type Ticket,
  type WeChatH5Payment,
  type WeChatJsapiPayment,
  type WeChatNativePayment,
  type WeChatOAuthSession,
  type WeChatOAuthStart,
  type WeChatPaymentChannel,
  type WeChatPaymentSwitchResult,
  type WaitlistEntry,
  type WaitlistJoin,
} from '@conference/contracts';
import { createLocalTicketIdentity } from '../utils/ticket-code';
import { MEMBER_DIRECTORY_REQUEST_TIMEOUT_MS } from '../utils/member-directory-refresh';
import { registrationIdempotencyKey } from '../utils/purchase-journey';

type WebRegistrationCheckout = RegistrationCheckout & { ticket?: Ticket };
export interface WebInvoiceAccess {
  id: string;
  requestNo: string;
  status: 'awaiting_details';
  accessToken: string;
  expiresAt: string;
}

type PaymentResult = {
  order: Order;
  ticket?: Ticket;
  invoice?: WebInvoiceAccess;
};

export function useConferenceApi() {
  const config = useRuntimeConfig();
  const baseURL = import.meta.server ? config.apiInternalBase : config.public.apiBase;
  const organizationSlug = config.public.organizationSlug;
  const eventState = useState<PublicEvent>('conference.public-event', () =>
    structuredClone(DEMO_EVENT),
  );

  function publicApiResourceUrl(path: string | undefined) {
    if (!path || /^https?:\/\//i.test(path)) return path;
    return `${String(config.public.apiBase).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  function isNetworkFailure(error: unknown) {
    const failure = error as { response?: { status?: number }; statusCode?: number };
    return !failure?.response?.status && !failure?.statusCode;
  }

  async function getEvent(slug = DEMO_EVENT.slug): Promise<PublicEvent> {
    try {
      const event = await $fetch<PublicEvent>(`/events/${slug}`, {
        baseURL,
        timeout: 4_000,
        headers: { 'X-Organization-Slug': organizationSlug },
      });
      saveEvent(event);
      return event;
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) {
        const event = structuredClone(DEMO_EVENT);
        saveEvent(event);
        return event;
      }
      throw error;
    }
  }

  async function getHomepageEvent() {
    try {
      const event = await $fetch<PublicEvent>('/homepage', {
        baseURL,
        timeout: 4_000,
        headers: { 'X-Organization-Slug': organizationSlug },
      });
      saveEvent(event);
      return event;
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) return getEvent(DEMO_EVENT.slug);
      throw error;
    }
  }

  function recordPublicEventView(slug: string, pageViewId: string): Promise<PublicEventViewResult> {
    return $fetch<PublicEventViewResult>(
      `/events/${encodeURIComponent(slug)}/public-metrics/view`,
      {
        method: 'POST',
        baseURL,
        timeout: 4_000,
        headers: { 'X-Organization-Slug': organizationSlug },
        body: { pageViewId },
      },
    );
  }

  async function getEventMembers(slug: string, page = 1, industry?: string) {
    const result = await $fetch<PublicEventMemberList>(
      `/events/${encodeURIComponent(slug)}/members`,
      {
        baseURL,
        timeout: MEMBER_DIRECTORY_REQUEST_TIMEOUT_MS,
        headers: { 'X-Organization-Slug': organizationSlug },
        query: { page, ...(industry ? { industry } : {}) },
      },
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        ...(item.avatarUrl ? { avatarUrl: publicApiResourceUrl(item.avatarUrl) } : {}),
      })),
    };
  }

  async function getEventMember(slug: string, publicSlug: string) {
    const result = await $fetch<PublicEventMemberDetail>(
      `/events/${encodeURIComponent(slug)}/members/${encodeURIComponent(publicSlug)}`,
      {
        baseURL,
        headers: { 'X-Organization-Slug': organizationSlug },
      },
    );
    return {
      ...result,
      ...(result.avatarUrl ? { avatarUrl: publicApiResourceUrl(result.avatarUrl) } : {}),
    };
  }

  async function getSiteConfiguration(): Promise<PublicSiteConfiguration> {
    try {
      return await $fetch<PublicSiteConfiguration>('/site-config', {
        baseURL,
        timeout: 4_000,
        headers: { 'X-Organization-Slug': organizationSlug },
      });
    } catch (error) {
      if (!import.meta.dev || !isNetworkFailure(error)) throw error;
      return {
        website: {
          siteName: '大会报名中心',
          seoTitle: '大会报名中心',
          seoDescription: '',
          faviconUrl: '',
          footerText: '',
          icpNumber: '',
          supportEmail: '',
        },
        analytics: {
          enabled: false,
          provider: 'baidu',
          trackingId: '',
          scriptUrl: '',
          siteId: '',
        },
        customerAccounts: {
          termsUrl: '',
          termsVersion: '',
          privacyUrl: '',
          privacyVersion: '',
        },
      };
    }
  }

  async function createRegistration(input: CreateRegistration): Promise<WebRegistrationCheckout> {
    const key = registrationIdempotencyKey(input.purchaseIntentId);
    try {
      return await $fetch<WebRegistrationCheckout>('/registrations', {
        method: 'POST',
        baseURL,
        credentials: 'include',
        headers: {
          'Idempotency-Key': key,
          'X-Organization-Slug': organizationSlug,
        },
        body: input,
      });
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) return createLocalCheckout(input);
      throw error;
    }
  }

  async function joinWaitlist(input: WaitlistJoin): Promise<WaitlistEntry> {
    try {
      return await $fetch<WaitlistEntry>('/waitlist', {
        method: 'POST',
        baseURL,
        credentials: 'include',
        headers: {
          'Idempotency-Key': `waitlist-${crypto.randomUUID()}`,
          'X-Organization-Slug': organizationSlug,
        },
        body: input,
      });
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) {
        const ticket = DEMO_EVENT.tickets.find((item) => item.id === input.ticketTypeId);
        return {
          id: crypto.randomUUID(),
          eventId: input.eventId,
          ticketTypeId: input.ticketTypeId,
          ticketTypeName: ticket?.name ?? '大会门票',
          name: input.name,
          email: input.email,
          mobile: input.mobile,
          status: 'waiting',
          position: 1,
          invitedAt: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        };
      }
      throw error;
    }
  }

  async function localPaymentSimulationCapability(orderId: string, accessToken: string) {
    return $fetch<{ allowed: boolean }>(`/payments/mock/${orderId}/capability`, {
      baseURL,
      timeout: 4_000,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  async function confirmPayment(
    order: Order,
    registrationId: string,
    accessToken: string,
  ): Promise<PaymentResult> {
    try {
      return await $fetch<PaymentResult>(`/payments/mock/${order.id}/confirm`, {
        method: 'POST',
        baseURL,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': `payment-${order.id}`,
        },
      });
    } catch (error) {
      if (!import.meta.dev || !isNetworkFailure(error)) throw error;
      const ticketIdentity = createLocalTicketIdentity(DEMO_EVENT.id);
      const checkout = readCheckout();
      const ticket: Ticket = {
        id: crypto.randomUUID(),
        ...ticketIdentity,
        registrationId,
        eventName: DEMO_EVENT.name,
        attendeeName: checkout?.registration.attendee.name ?? '参会者',
        ticketTypeName: checkout?.registration.ticketType.name ?? '大会门票',
        status: 'valid',
        issuedAt: new Date().toISOString(),
      };
      return { order: { ...order, status: 'paid' as const }, ticket };
    }
  }

  /**
   * Prepares a WeChat Native (QR) payment attempt for an order.
   *
   * @param orderId - Order identifier
   * @param accessToken - Bearer order access token
   * @returns Native prepare payload including codeUrl
   */
  function prepareWeChatNativePayment(
    orderId: string,
    accessToken: string,
  ): Promise<WeChatNativePayment> {
    return $fetch<WeChatNativePayment>(`/payments/wechat/${orderId}/native`, {
      method: 'POST',
      baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': `wechat-native-${orderId}`,
      },
    });
  }

  /**
   * Prepares a WeChat JSAPI payment attempt bound to an OAuth session.
   *
   * @param orderId - Order identifier
   * @param accessToken - Bearer order access token
   * @param oauthSessionToken - Server OAuth session from handoff exchange (never an openid)
   * @returns JSAPI prepare payload including signed jsapiParams
   */
  function prepareWeChatJsapiPayment(
    orderId: string,
    accessToken: string,
    oauthSessionToken: string,
  ): Promise<WeChatJsapiPayment> {
    return $fetch<WeChatJsapiPayment>(`/payments/wechat/${orderId}/jsapi`, {
      method: 'POST',
      baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Wechat-OAuth-Session': oauthSessionToken,
        'Idempotency-Key': `wechat-jsapi-${orderId}`,
      },
    });
  }

  /**
   * Prepares a WeChat H5 payment attempt for mobile external browsers.
   *
   * @param orderId - Order identifier
   * @param accessToken - Bearer order access token
   * @returns H5 prepare payload including h5Url
   */
  function prepareWeChatH5Payment(orderId: string, accessToken: string): Promise<WeChatH5Payment> {
    return $fetch<WeChatH5Payment>(`/payments/wechat/${orderId}/h5`, {
      method: 'POST',
      baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': `wechat-h5-${orderId}`,
      },
    });
  }

  /**
   * Starts WeChat snsapi_base OAuth for JSAPI checkout.
   *
   * @param orderId - Order identifier
   * @param accessToken - Bearer order access token
   * @param returnPath - Optional path under the payment base after callback
   * @returns Authorize URL for browser redirect
   */
  function startWeChatOAuth(
    orderId: string,
    accessToken: string,
    returnPath?: string,
  ): Promise<WeChatOAuthStart> {
    return $fetch<WeChatOAuthStart>(`/payments/wechat/${orderId}/oauth/start`, {
      method: 'POST',
      baseURL,
      headers: { Authorization: `Bearer ${accessToken}` },
      body: returnPath ? { returnPath } : {},
    });
  }

  /**
   * Exchanges a one-time OAuth handoff fragment code for a short-lived session token.
   *
   * @param handoffCode - Code from `#handoff=` after OAuth callback
   * @returns OAuth session bound to the order
   */
  function exchangeWeChatOAuthHandoff(handoffCode: string): Promise<WeChatOAuthSession> {
    return $fetch<WeChatOAuthSession>('/payments/wechat/oauth/handoff', {
      method: 'POST',
      baseURL,
      body: { handoffCode },
    });
  }

  /**
   * Closes the active WeChat attempt so the next prepare can use a different channel.
   *
   * @param orderId - Order identifier
   * @param accessToken - Bearer order access token
   * @param channel - Target payment channel
   * @returns Paid acknowledgement or the newly prepared channel payload
   */
  function switchWeChatPaymentChannel(
    orderId: string,
    accessToken: string,
    channel: WeChatPaymentChannel,
  ): Promise<WeChatPaymentSwitchResult> {
    return $fetch<WeChatPaymentSwitchResult>(`/payments/wechat/${orderId}/switch`, {
      method: 'POST',
      baseURL,
      headers: { Authorization: `Bearer ${accessToken}` },
      body: { channel },
    });
  }

  /**
   * Builds the absolute or relative checkout URL for a paid registration order.
   * When paymentOrigin is configured, returns the full PAYMENT_PUBLIC_URL order link.
   * Access tokens are only placed in the fragment, never in the query string.
   *
   * @param orderId - Order identifier
   * @param eventSlug - Event slug for query context
   * @param accessToken - Optional fragment access token
   * @returns Checkout URL safe for cross-origin redirect
   */
  function resolvePaymentCheckoutUrl(
    orderId: string,
    eventSlug: string,
    accessToken?: string,
  ): string {
    const paymentOrigin = String(config.public.paymentOrigin ?? '').replace(/\/+$/, '');
    const paymentBasePath = String(config.public.paymentBasePath ?? '/pay/hui').replace(/\/+$/, '');
    const query = eventSlug ? `?event=${encodeURIComponent(eventSlug)}` : '';
    const hash = accessToken ? `#access=${encodeURIComponent(accessToken)}` : '';
    const path = `/order/${encodeURIComponent(orderId)}${query}${hash}`;
    if (paymentOrigin) {
      return `${paymentOrigin}${paymentBasePath}${path}`;
    }
    return path;
  }

  /**
   * Resolves a conference-site URL. On the payment surface this becomes an absolute
   * link back to conferenceOrigin so users leave www/pay/hui for 大会 / 报名 / 用户中心.
   *
   * @param path - Site-relative path beginning with `/`
   * @returns Absolute conference URL or the original relative path
   */
  function resolveConferenceUrl(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const conferenceOrigin = String(config.public.conferenceOrigin ?? '').replace(/\/+$/, '');
    if (config.public.paymentSurface && conferenceOrigin) {
      return `${conferenceOrigin}${normalized}`;
    }
    return normalized;
  }

  /**
   * Whether the current Nuxt instance is the payment-web surface (www/pay/hui).
   *
   * @returns True when NUXT_PUBLIC_PAYMENT_SURFACE=true
   */
  function isPaymentSurface(): boolean {
    return config.public.paymentSurface === true;
  }

  async function submitInvoiceDetails(invoiceId: string, input: SubmitInvoiceDetails) {
    return $fetch<{ id: string; requestNo: string; status: string }>(
      `/invoices/${invoiceId}/details`,
      {
        method: 'POST',
        baseURL,
        body: input,
      },
    );
  }

  async function submitOrderInvoice(orderId: string, input: SubmitInvoiceDetails) {
    const { accessToken, ...details } = input;
    return $fetch<{ id: string; requestNo: string; status: string }>(
      `/orders/${orderId}/invoice-request`,
      {
        method: 'POST',
        baseURL,
        headers: { Authorization: `Bearer ${accessToken}` },
        body: details,
      },
    );
  }

  async function getOrderInvoice(orderId: string, accessToken: string) {
    return $fetch<Record<string, unknown>>(`/orders/${orderId}/invoice-request`, {
      baseURL,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  async function requestOrderAccessLink(orderNo: string, email: string) {
    return $fetch<{ accepted: true; message: string }>('/orders/access-links', {
      method: 'POST',
      baseURL,
      body: { orderNo, email },
    });
  }

  /**
   * Loads an order by id, optionally forcing a WeChat transaction sync.
   *
   * @param identifier - Order UUID
   * @param accessToken - Order access bearer token
   * @param options - Pass `sync: true` after the user finishes paying to bypass query throttle
   * @returns Latest order snapshot
   */
  async function getOrder(
    identifier: string,
    accessToken?: string,
    options: { sync?: boolean } = {},
  ) {
    try {
      return await $fetch<CustomerOrderAccess>(`/orders/${identifier}`, {
        baseURL,
        query: options.sync ? { sync: '1' } : undefined,
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) {
        const checkout = readCheckout();
        return checkout
          ? { ...checkout.order, isProxyPurchase: checkout.isProxyPurchase }
          : undefined;
      }
      throw error;
    }
  }

  async function getTicket(identifier: string) {
    try {
      return await $fetch<Ticket>(`/tickets/${identifier}`, { baseURL });
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) return readTicket(identifier);
      throw error;
    }
  }

  async function getOrderTicket(identifier: string, accessToken: string) {
    try {
      return await $fetch<Ticket>(`/orders/${identifier}/ticket`, {
        baseURL,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      if (import.meta.dev && isNetworkFailure(error)) {
        const local = readCheckout()?.ticket;
        if (local) return local;
      }
      throw error;
    }
  }

  function createLocalCheckout(input: CreateRegistration): WebRegistrationCheckout {
    const localEvent = readEvent() ?? DEMO_EVENT;
    const ticket = localEvent.tickets.find((item) => item.id === input.ticketTypeId)!;
    const registrationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const isFree = ticket.price === 0;
    const issuedTicket: Ticket | undefined = isFree
      ? {
          id: crypto.randomUUID(),
          ...createLocalTicketIdentity(localEvent.id),
          registrationId,
          eventName: localEvent.name,
          attendeeName: input.attendee.name,
          ticketTypeName: ticket.name,
          status: 'valid',
          issuedAt: createdAt,
        }
      : undefined;
    return {
      isProxyPurchase: input.purchaseFor === 'other',
      registration: {
        id: registrationId,
        eventId: input.eventId,
        registrationCode: `TOK-R-${registrationId.slice(0, 8).toUpperCase()}`,
        status: isFree ? 'confirmed' : 'pending_payment',
        attendee: input.attendee,
        ticketType: ticket,
        createdAt,
      },
      order: {
        id: crypto.randomUUID(),
        orderNo: `TOK2026${Date.now().toString().slice(-10)}`,
        registrationId,
        status: isFree ? 'paid' : 'pending_payment',
        amount: ticket.price,
        currency: ticket.currency,
        paymentMethod: isFree ? 'free' : 'wechat',
        expiresAt: isFree ? createdAt : new Date(Date.now() + 15 * 60_000).toISOString(),
        createdAt,
      },
      orderAccessToken:
        crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      ...(issuedTicket ? { ticket: issuedTicket } : {}),
    };
  }

  function readCheckout(): WebRegistrationCheckout | undefined {
    if (!import.meta.client) return undefined;
    const value = sessionStorage.getItem('conference.checkout');
    return value ? (JSON.parse(value) as WebRegistrationCheckout) : undefined;
  }

  function saveCheckout(checkout: WebRegistrationCheckout) {
    if (import.meta.client) sessionStorage.setItem('conference.checkout', JSON.stringify(checkout));
  }

  function readEvent(): PublicEvent | undefined {
    if (!import.meta.client) return eventState.value;
    const value = sessionStorage.getItem('conference.event');
    return value ? (JSON.parse(value) as PublicEvent) : eventState.value;
  }

  function saveEvent(event: PublicEvent) {
    eventState.value = event;
    if (import.meta.client) sessionStorage.setItem('conference.event', JSON.stringify(event));
  }

  function readTicket(identifier: string): Ticket | undefined {
    if (!import.meta.client) return undefined;
    const value = sessionStorage.getItem('conference.ticket');
    if (!value) return undefined;
    const ticket = JSON.parse(value) as Ticket;
    return ticket.code === identifier || ticket.registrationId === identifier ? ticket : undefined;
  }

  function saveTicket(ticket: Ticket) {
    if (import.meta.client) sessionStorage.setItem('conference.ticket', JSON.stringify(ticket));
  }

  function readInvoiceAccess(invoiceId?: string): WebInvoiceAccess | undefined {
    if (!import.meta.client) return undefined;
    const value = sessionStorage.getItem('conference.invoiceAccess');
    if (!value) return undefined;
    const access = JSON.parse(value) as WebInvoiceAccess;
    return !invoiceId || access.id === invoiceId ? access : undefined;
  }

  function saveInvoiceAccess(access: WebInvoiceAccess) {
    if (import.meta.client) {
      sessionStorage.setItem('conference.invoiceAccess', JSON.stringify(access));
    }
  }

  function clearInvoiceAccess() {
    if (import.meta.client) sessionStorage.removeItem('conference.invoiceAccess');
  }

  function invoiceDownloadUrl(path: string) {
    return `${String(baseURL).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }

  return {
    eventState,
    getEvent,
    getHomepageEvent,
    recordPublicEventView,
    getEventMembers,
    getEventMember,
    getSiteConfiguration,
    createRegistration,
    joinWaitlist,
    confirmPayment,
    localPaymentSimulationCapability,
    prepareWeChatNativePayment,
    prepareWeChatJsapiPayment,
    prepareWeChatH5Payment,
    startWeChatOAuth,
    exchangeWeChatOAuthHandoff,
    switchWeChatPaymentChannel,
    resolvePaymentCheckoutUrl,
    resolveConferenceUrl,
    isPaymentSurface,
    getOrder,
    getTicket,
    getOrderTicket,
    readCheckout,
    saveCheckout,
    readEvent,
    saveEvent,
    readTicket,
    saveTicket,
    submitInvoiceDetails,
    submitOrderInvoice,
    getOrderInvoice,
    requestOrderAccessLink,
    readInvoiceAccess,
    saveInvoiceAccess,
    clearInvoiceAccess,
    invoiceDownloadUrl,
  };
}
