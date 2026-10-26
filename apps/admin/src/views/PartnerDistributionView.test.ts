import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'vue';
import { DEFAULT_PARTNER_POSTER_FIELDS, PARTNER_POSTER_DEFAULT_COPY } from '@conference/contracts';
import PartnerDistributionView from './PartnerDistributionView.vue';

const api = vi.hoisted(() => ({
  getPartnerDistributionOverview: vi.fn(),
  getEventPartners: vi.fn(),
  getPartnerCommissions: vi.fn(),
  getPartnerCommissionInquiries: vi.fn(),
  getPartnerPayouts: vi.fn(),
  getPartnerPayoutSettings: vi.fn(),
  publishPartnerProgram: vi.fn(),
  enableEventPartner: vi.fn(),
  updateEventPartnerDetails: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const { ref } = await import('vue');
  return {
    conferenceApi: api,
    session: {
      can: () => true,
      activeEvent: ref({ id: 101, name: '第二届中国GEO大会' }),
    },
  };
});

vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn(), onBeforeRouteUpdate: vi.fn() }));

vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onBeforeUnmount: vi.fn(),
  onMounted: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));

interface State {
  enableDialogOpen: Ref<boolean>;
  partnerInvitationOpen: Ref<boolean>;
  partnerInvitationError: Ref<string>;
  partnerInvitationIssues: Ref<Array<{ field: string; message: string }>>;
  partnerEditorIssues: Ref<Array<{ field: string; message: string }>>;
  partnerEditorNotice: Ref<string>;
  pending: Ref<boolean>;
  partnerEditorTab: Ref<'profile' | 'promotion'>;
  partnerFormDirty: Ref<boolean>;
  pendingAvatarAssetId: Ref<string | null | undefined>;
  openPartnerInvitation: () => void;
  closePartnerInvitation: () => void;
  enableForm: {
    mobile: string;
    displayName: string;
    company: string;
    title: string;
    ratePercent: string;
    note: string;
  };
  editForm: {
    displayName: string;
    company: string;
    title: string;
    industry: string;
    businessIntro: string;
    businessUrl: string;
    ratePercent: string;
    sortOrder: string;
    internalNote: string;
  };
  overview: Ref<Record<string, unknown>>;
  editingPartner: Ref<Record<string, unknown> | null>;
  successMessage: Ref<string>;
  requestEnableDistribution: () => void;
  enableDistribution: () => Promise<void>;
  enablePartner: () => Promise<void>;
  openPartnerEditor: (partner: Record<string, unknown>) => void;
  savePartnerDetails: () => Promise<void>;
}

function state() {
  const setup = PartnerDistributionView.setup;
  if (!setup) throw new Error('Partner distribution component has no setup function');
  return setup({}, { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }) as unknown as State;
}

describe('partner distribution quick enable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.publishPartnerProgram.mockResolvedValue({});
    api.enableEventPartner.mockResolvedValue({
      profile: { displayName: '张三', company: '', title: '', industry: '', businessIntro: '', businessUrl: '' },
      eventId: 101, eventName: '大会', personalRateBps: null,
      id: 'a761c83a-143b-4447-b018-a03c238b2be7',
      created: true,
      qualificationStatus: 'pending_confirmation',
    });
    api.updateEventPartnerDetails.mockResolvedValue({});
    api.getPartnerDistributionOverview.mockResolvedValue({
      program: {
        mode: 'fixed',
        fixedRateBps: 1000,
        attributionDays: 30,
        settlementDelayDays: 7,
        minimumPayoutAmount: 1000,
        publicDirectoryEnabled: false,
        homepageLimit: 12,
      },
      partnerCounts: {},
      commissionTotals: {},
      payoutTotals: {},
    });
    api.getEventPartners.mockResolvedValue({ items: [] });
    api.getPartnerCommissions.mockResolvedValue({ items: [] });
    api.getPartnerCommissionInquiries.mockResolvedValue({ items: [] });
    api.getPartnerPayouts.mockResolvedValue({
      requests: [],
      batches: [],
      inquiries: [],
      recipients: [],
      documents: [],
      reconciliations: [],
    });
    api.getPartnerPayoutSettings.mockResolvedValue({});
  });

  it('publishes the locked default rules after explicit confirmation', async () => {
    const view = state();
    view.requestEnableDistribution();
    expect(view.enableDialogOpen.value).toBe(true);

    await view.enableDistribution();

    expect(api.publishPartnerProgram).toHaveBeenCalledWith({
      mode: 'fixed',
      fixedRateBps: 1000,
      tiers: [],
      eligibleTicketTypeIds: [],
      attributionDays: 30,
      settlementDelayDays: 7,
      minimumPayoutAmount: 1000,
      payoutCadence: 'weekly',
      termsTitle: '大会合作伙伴推广规则',
      termsContent:
        '合作伙伴应使用本人专属链接开展真实推广。佣金按成功付款且符合资格的订单明细计算，退款与自购会按规则冲正。',
      promotionPolicy: '推广内容应真实、清晰，不得承诺大会未公开的权益。',
      publicDirectoryEnabled: false,
      homepageLimit: 12,
    });
    expect(view.successMessage.value).toBe('分销功能已开启，后台添加合作伙伴后即可开始推广归因。');
    expect(view.enableDialogOpen.value).toBe(false);
  });

  it('invites a partner with optional profile fields and a custom commission rate', async () => {
    const view = state();
    view.openPartnerInvitation();
    view.overview.value = {
      program: {
        mode: 'fixed',
        fixedRateBps: 1000,
      },
    };
    view.enableForm.mobile = '13800138000';
    view.enableForm.displayName = ' 张三 ';
    view.enableForm.company = ' 山海科技 ';
    view.enableForm.title = ' 市场副总裁 ';
    view.enableForm.ratePercent = '12.5';
    view.enableForm.note = '重点渠道伙伴';

    await view.enablePartner();

    expect(api.enableEventPartner).toHaveBeenCalledWith({
      mobile: '13800138000',
      displayName: '张三',
      company: '山海科技',
      title: '市场副总裁',
      personalRateBps: 1250,
      sortOrder: 0,
      internalNote: '重点渠道伙伴',
      sendInvitation: true,
    });
    expect(view.successMessage.value).toBe(
      '合作伙伴创建成功。',
    );
    expect(view.enableForm.mobile).toBe('');
    expect(view.enableForm.displayName).toBe('');
    expect(view.enableForm.company).toBe('');
    expect(view.enableForm.title).toBe('');
    expect(view.enableForm.ratePercent).toBe('');
    expect(view.enableForm.note).toBe('');
    expect(view.partnerInvitationOpen.value).toBe(false);
    expect(view.partnerEditorTab.value).toBe('promotion');
    expect(view.editingPartner.value?.id).toBe('a761c83a-143b-4447-b018-a03c238b2be7');
  });

  it('keeps failed invitations open with their input and allows a successful retry', async () => {
    const view = state();
    view.overview.value = { program: { mode: 'fixed', fixedRateBps: 1000 } };
    view.openPartnerInvitation();
    view.enableForm.mobile = '13800138000';
    view.enableForm.displayName = '张三';
    api.enableEventPartner.mockRejectedValueOnce(new Error('暂时无法开通，请重试'));

    await view.enablePartner();

    expect(view.partnerInvitationOpen.value).toBe(true);
    expect(view.partnerInvitationError.value).toBe('暂时无法开通，请重试');
    expect(view.enableForm.mobile).toBe('13800138000');
    expect(view.enableForm.displayName).toBe('张三');

    await view.enablePartner();

    expect(view.partnerInvitationOpen.value).toBe(false);
    expect(view.partnerInvitationError.value).toBe('');
  });

  it('prevents closing an invitation while it is being submitted', async () => {
    const view = state();
    view.overview.value = { program: { mode: 'fixed', fixedRateBps: 1000 } };
    view.openPartnerInvitation();
    view.enableForm.mobile = '13800138000';
    let finish!: (value: Record<string, unknown>) => void;
    api.enableEventPartner.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const submission = view.enablePartner();
    view.closePartnerInvitation();
    await view.enablePartner();

    expect(view.pending.value).toBe(true);
    expect(view.partnerInvitationOpen.value).toBe(true);
    expect(api.enableEventPartner).toHaveBeenCalledTimes(1);
    finish({ id: 'a761c83a-143b-4447-b018-a03c238b2be7', created: true, profile: { displayName: '张三' }, personalRateBps: null });
    await submission;
    expect(view.partnerInvitationOpen.value).toBe(false);
  });

  it('edits event profile and explicit zero commission for partners in any state', async () => {
    const view = state();
    const partner = {
      id: 'a761c83a-143b-4447-b018-a03c238b2be7',
      version: 4,
      eventId: 101,
      loginMobile: '+8613800138000',
      sortOrder: 8,
      internalNote: '原备注',
      personalRateBps: null,
      qualificationStatus: 'closed',
      profile: {
        displayName: '张三',
        company: '山海科技',
        title: '市场副总裁',
        industry: '人工智能',
        businessIntro: '原介绍',
        businessUrl: '',
      },
    };

    view.openPartnerEditor(partner);
    view.editForm.company = '远山科技';
    view.editForm.businessUrl = 'https://example.com';
    view.editForm.ratePercent = '0';
    view.editForm.sortOrder = '3';
    view.editForm.internalNote = '线下签约';
    await view.savePartnerDetails();

    expect(api.updateEventPartnerDetails).toHaveBeenCalledWith(partner.id, {
      expectedVersion: 4,
      displayName: '张三',
      company: '远山科技',
      title: '市场副总裁',
      industry: '人工智能',
      businessIntro: '原介绍',
      businessUrl: 'https://example.com',
      personalRateBps: 0,
      sortOrder: 3,
      internalNote: '线下签约',
      posterCopy: PARTNER_POSTER_DEFAULT_COPY,
      posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
    }, partner.eventId);
    expect(view.successMessage.value).toBe('合作伙伴资料和佣金设置已更新。');
  });

  it('opens the existing partner editor for a duplicate mobile invitation', async () => {
    const view = state();
    view.openPartnerInvitation();
    const partner = {
      id: 'a761c83a-143b-4447-b018-a03c238b2be7',
      version: 2,
      loginMobile: '+8613800138000',
      sortOrder: 0,
      internalNote: '',
      personalRateBps: null,
      qualificationStatus: 'paused',
      profile: {
        displayName: '张三',
        company: '',
        title: '',
        industry: '',
        businessIntro: '',
        businessUrl: '',
      },
    };
    view.overview.value = { program: { mode: 'fixed', fixedRateBps: 1000 } };
    view.enableForm.mobile = '13800138000';
    api.enableEventPartner.mockResolvedValue({ ...partner, created: false });
    api.getEventPartners.mockResolvedValue({ items: [{ ...partner, sortOrder: 99, internalNote: '旧列表备注' }] });

    await view.enablePartner();

    expect(view.editingPartner.value?.id).toBe(partner.id);
    expect(view.editForm.sortOrder).toBe('0');
    expect(view.editForm.internalNote).toBe('');
    expect(view.partnerEditorNotice.value).toContain('该手机号已是本大会的合作伙伴');
    expect(view.partnerInvitationOpen.value).toBe(false);
    expect(view.successMessage.value).toBe('该手机号已经是合作伙伴，已为你打开资料编辑。');
  });

  it('keeps edits made while a save is in flight marked as unsaved', async () => {
    const view = state();
    const partner = {
      id: 'a761c83a-143b-4447-b018-a03c238b2be7', version: 1, eventId: 101,
      loginMobile: '+8613800138000', sortOrder: 0, internalNote: '', personalRateBps: null,
      profile: { displayName: '林安', company: '', title: '', industry: '', businessIntro: '', businessUrl: '' },
    };
    view.openPartnerEditor(partner);
    view.editForm.displayName = '第一次提交';
    let finish!: (result: Record<string, unknown>) => void;
    api.updateEventPartnerDetails.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = view.savePartnerDetails();
    expect(view.pending.value).toBe(true);
    view.editForm.displayName = '等待期间的新输入';
    finish({ ...partner, version: 2, profile: { ...partner.profile, displayName: '第一次提交' } });
    await saving;
    expect(view.editForm.displayName).toBe('等待期间的新输入');
    expect(view.partnerFormDirty.value).toBe(true);
    expect(view.partnerEditorTab.value).toBe('profile');
  });

  it('returns to the profile tab when validation fails from promotion', async () => {
    const view = state();
    view.openPartnerEditor({
      id: 'a761c83a-143b-4447-b018-a03c238b2be7', version: 1, eventId: 101,
      loginMobile: '+8613800138000', sortOrder: 0, internalNote: '', personalRateBps: null,
      profile: { displayName: '林安', company: '', title: '', industry: '', businessIntro: '', businessUrl: '' },
    });
    view.editForm.businessUrl = 'ftp://example.com';
    view.partnerEditorTab.value = 'promotion';
    await view.savePartnerDetails();
    expect(view.partnerEditorTab.value).toBe('profile');
    expect(api.updateEventPartnerDetails).not.toHaveBeenCalled();
  });

  it('clears the saved avatar draft while retaining text entered during its save', async () => {
    const view = state();
    const partner = {
      id: 'a761c83a-143b-4447-b018-a03c238b2be7', version: 1, eventId: 101,
      loginMobile: '+8613800138000', sortOrder: 0, internalNote: '', personalRateBps: null,
      profile: { displayName: '林安', company: '', title: '', industry: '', businessIntro: '', businessUrl: '' },
    };
    view.openPartnerEditor(partner);
    view.pendingAvatarAssetId.value = 'ead73b17-b02e-431a-a05d-7db3a0918260';
    let finish!: (result: Record<string, unknown>) => void;
    api.updateEventPartnerDetails.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = view.savePartnerDetails();
    view.editForm.displayName = '等待期间的新输入';
    finish({ ...partner, version: 2 });
    await saving;
    expect(view.partnerFormDirty.value).toBe(true);
    expect(view.pendingAvatarAssetId.value).toBeUndefined();
    view.editForm.displayName = '林安';
    expect(view.partnerFormDirty.value).toBe(false);
  });

  it('ignores a save response after another editor session opens', async () => {
    const view = state();
    const partner = {
      id: 'a761c83a-143b-4447-b018-a03c238b2be7', version: 1, eventId: 101,
      loginMobile: '+8613800138000', sortOrder: 0, internalNote: '', personalRateBps: null,
      profile: { displayName: '林安', company: '', title: '', industry: '', businessIntro: '', businessUrl: '' },
    };
    view.openPartnerEditor(partner);
    view.editForm.displayName = '旧会话提交';
    let finish!: (result: Record<string, unknown>) => void;
    api.updateEventPartnerDetails.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = view.savePartnerDetails();
    view.openPartnerEditor(partner);
    view.editForm.displayName = '新会话草稿';
    finish({ ...partner, version: 2, profile: { ...partner.profile, displayName: '旧会话提交' } });
    await saving;
    expect(view.editingPartner.value?.version).toBe(1);
    expect(view.editForm.displayName).toBe('新会话草稿');
    expect(view.partnerEditorNotice.value).toBe('');
  });

  it.each([
    ['displayName', '', 'displayName'],
    ['businessUrl', 'ftp://example.com', 'businessUrl'],
    ['ratePercent', '-0.001', 'personalRateBps'],
    ['sortOrder', '1.5', 'sortOrder'],
  ])('identifies invalid %s before updating a partner', async (field, value, expectedField) => {
    const view = state();
    view.openPartnerEditor({
      id: 'a761c83a-143b-4447-b018-a03c238b2be7',
      version: 1,
      personalRateBps: null,
      sortOrder: 0,
      internalNote: '',
      profile: {
        displayName: '测试伙伴',
        company: '',
        title: '',
        industry: '',
        businessIntro: '',
        businessUrl: '',
      },
    });
    view.editForm[field as keyof State['editForm']] = value;
    await view.savePartnerDetails();
    expect(api.updateEventPartnerDetails).not.toHaveBeenCalled();
    expect(view.editingPartner.value).not.toBeNull();
    expect(view.partnerEditorIssues.value.map((issue) => issue.field)).toContain(expectedField);
  });

  it('keeps server validation errors next to the invitation fields', async () => {
    const view = state();
    view.overview.value = { program: { mode: 'fixed', fixedRateBps: 1000 } };
    view.openPartnerInvitation();
    view.enableForm.mobile = '13800138000';
    api.enableEventPartner.mockRejectedValueOnce(
      Object.assign(new Error('合作伙伴开通信息校验失败'), {
        details: { issues: [{ path: ['mobile'], code: 'invalid_format' }] },
      }),
    );
    await view.enablePartner();
    expect(view.partnerInvitationOpen.value).toBe(true);
    expect(view.partnerInvitationIssues.value[0]?.message).toContain('合作伙伴手机号');
    expect(view.enableForm.mobile).toBe('13800138000');
  });

  it('does not invite while the event distribution program is closed', async () => {
    const view = state();
    view.enableForm.mobile = '13800138000';

    await view.enablePartner();

    expect(api.enableEventPartner).not.toHaveBeenCalled();
  });
});
