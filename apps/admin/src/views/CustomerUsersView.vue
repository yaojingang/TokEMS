<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { resolveCustomerAdminDisplay } from '@conference/contracts';
import type {
  CustomerAdminDetail,
  CustomerAdminExportQuery,
  CustomerAdminSummary,
  CustomerStatus,
  OrganizationInvitation,
  OrganizationMember,
} from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import {
  administratorDirectoryInvitations,
  administratorDirectoryMembers,
} from '../lib/administrator-directory';
import { buildAdministratorLoginUrl } from '../lib/administrator-login-url';
import { conferenceApi, session } from '../lib/api';
import { organizationRoleLabel } from '../lib/roles';

type DirectoryKind = 'customers' | 'administrators';
type CreateAccountKind = 'customer' | 'administrator';

const items = ref<CustomerAdminSummary[]>([]);
const selected = ref<CustomerAdminDetail>();
const deleteTarget = ref<CustomerAdminSummary>();
const detailDialog = ref<HTMLDialogElement>();
const deleteDialog = ref<HTMLDialogElement>();
const createAccountDialog = ref<HTMLDialogElement>();
const administratorEditDialog = ref<HTMLDialogElement>();
const customerListHeading = ref<HTMLElement>();
const detailTrigger = ref<HTMLButtonElement>();
const deleteTrigger = ref<HTMLButtonElement>();
const createAccountTrigger = ref<HTMLButtonElement>();
const administratorEditTrigger = ref<HTMLButtonElement>();
const registrationHistoryHeading = ref<HTMLElement>();
const detailOpen = ref(false);
const deleteOpen = ref(false);
const createAccountOpen = ref(false);
const administratorEditOpen = ref(false);
const createAccountKind = ref<CreateAccountKind>('customer');
const activeDirectory = ref<DirectoryKind>('customers');
const exportConfirmation = ref(false);
const exporting = ref(false);
const appliedFilters = ref<CustomerAdminExportQuery>({});
const exportQuery = ref<CustomerAdminExportQuery>({});
const exportTotal = ref(0);
const openMenuId = ref<number | null>(null);
const menuTrigger = ref<HTMLButtonElement>();
const menuPosition = reactive({ top: 0, left: 0 });
const loading = ref(true);
const detailLoading = ref(false);
const historyLoading = ref(false);
const invoiceHistoryLoading = ref(false);
const pending = ref(false);
const moderationPendingId = ref('');
const moderationReasons = reactive<Record<string, string>>({});
const deletePending = ref(false);
const createAccountPending = ref(false);
const administratorEditPending = ref(false);
const administratorDeletePending = ref(false);
const administratorsLoading = ref(false);
const administratorsLoaded = ref(false);
const administrators = ref<OrganizationMember[]>([]);
const administratorInvitations = ref<OrganizationInvitation[]>([]);
const administratorEditTarget = ref<OrganizationMember>();
const administratorDeleteTarget = ref<OrganizationMember>();
const total = ref(0);
const page = ref(1);
const totalPages = ref(1);
const message = ref('');
const errorMessage = ref('');
const detailMessage = ref('');
const detailErrorMessage = ref('');
const deleteErrorMessage = ref('');
const createAccountErrorMessage = ref('');
const administratorEditErrorMessage = ref('');
const administratorDeleteErrorMessage = ref('');
const administratorLoginUrl = ref('');
let loadRequestId = 0;
const filters = reactive({
  q: '',
  status: '' as '' | CustomerStatus,
});
const form = reactive({
  nickname: '',
  realName: '',
  email: '',
  company: '',
  title: '',
  city: '',
  status: 'active' as CustomerStatus,
  internalNote: '',
  tags: '',
});
const createCustomerForm = reactive({
  mobile: '',
  nickname: '',
  realName: '',
  email: '',
  company: '',
  title: '',
  city: '',
});
const createAdministratorForm = reactive({ username: '', password: '' });
const editAdministratorForm = reactive({ username: '', password: '' });
const canManage = computed(() => session.can('customer.manage'));
const canManageStatus = computed(() => session.can('customer.status.manage'));
const canDelete = computed(() => session.can('customer.delete'));
const canExport = computed(() => session.canAll(['customer.read', 'customer.export']));
const canReadAdministrators = computed(() => session.can('org.member.read'));
const isSuperAdministrator = computed(
  () => session.identity.value?.membership.isSuperAdministrator === true,
);
const canCreateAdministrator = computed(() => isSuperAdministrator.value);
const administratorEditDirty = computed(() => {
  const target = administratorEditTarget.value;
  if (!target) return false;
  const username = editAdministratorForm.username.trim().toLowerCase();
  return (
    Boolean(username && username !== (target.username ?? '')) ||
    Boolean(editAdministratorForm.password)
  );
});
const pendingAdministratorInvitations = computed(() =>
  administratorInvitations.value.filter((item) => item.status === 'pending'),
);
const directoryCountLabel = computed(() =>
  activeDirectory.value === 'customers'
    ? `${total.value} USERS`
    : `${administrators.value.length} ADMINS`,
);
const hasFilters = computed(() => Boolean(filters.q.trim() || filters.status));
const selectedSummary = computed(() =>
  items.value.find((item) => item.id === selected.value?.customer.id),
);
const selectedName = computed(() => {
  const customer = selected.value?.customer;
  return (
    selectedSummary.value?.displayName ||
    customer?.profile.realName ||
    customer?.profile.nickname ||
    domesticMobile(customer?.mobile) ||
    '用户详情'
  );
});
const deleteTargetName = computed(() => deleteTarget.value?.displayName || '当前用户');
const administratorDeleteDetails = computed(() => {
  const target = administratorDeleteTarget.value;
  if (!target) return [];
  return [
    {
      label: '管理员',
      value: target.username || target.email || target.name,
    },
    { label: '当前组织', value: session.identity.value?.organization.name || '当前组织' },
  ];
});
const visibleRange = computed(() => {
  if (!total.value) return '暂无用户';
  const start = (page.value - 1) * 20 + 1;
  const end = Math.min(page.value * 20, total.value);
  return `第 ${start}～${end} 条，共 ${total.value} 条`;
});
const paginationItems = computed<Array<number | 'ellipsis'>>(() => {
  if (totalPages.value <= 7) {
    return Array.from({ length: totalPages.value }, (_, index) => index + 1);
  }
  const anchors = [...new Set([1, page.value - 1, page.value, page.value + 1, totalPages.value])]
    .filter((item) => item >= 1 && item <= totalPages.value)
    .sort((left, right) => left - right);
  const result: Array<number | 'ellipsis'> = [];
  for (const [index, item] of anchors.entries()) {
    if (index > 0 && item - anchors[index - 1]! > 1) result.push('ellipsis');
    result.push(item);
  }
  return result;
});

const statusLabel: Record<CustomerStatus, string> = {
  active: '正常',
  blocked: '已封禁',
  closed: '已关闭',
};
const registrationStatusLabel: Record<string, string> = {
  draft: '草稿',
  pending_payment: '待支付',
  pending_review: '待审核',
  confirmed: '报名成功',
  cancelled: '已取消',
  checked_in: '已签到',
  completed: '已完成',
};
const invoiceStatusLabel: Record<string, string> = {
  awaiting_details: '待补资料',
  pending_review: '待审核',
  issuing: '开具中',
  issue_failed: '开具失败',
  issued: '已开具',
  rejected: '已驳回',
  adjustment_required: '待调整',
  voided: '已作废',
  cancelled: '已取消',
};
const showcaseFieldLabels: Record<string, string> = {
  avatar: '头像',
  displayName: '姓名',
  company: '公司',
  title: '职位',
  industry: '行业',
  businessIntro: '业务介绍',
  businessUrl: '项目网址',
  contactPhone: '联系电话',
  contactEmail: '联系邮箱',
  wechatId: '微信号',
};

function registrationStatus(value: string) {
  return registrationStatusLabel[value] || value;
}

function date(value: string | null | undefined) {
  if (!value) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(value))
    .replaceAll('/', '-');
}

function domesticMobile(value: string | null | undefined) {
  if (!value) return '';
  return value.startsWith('+86') ? value.slice(3) : value;
}

function money(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
  }).format(value / 100);
}

function showcasePath(showcase: CustomerAdminDetail['showcases'][number]) {
  return showcase.publicPreviewUrl ?? '';
}

function assignForm(detail: CustomerAdminDetail) {
  const profile = detail.customer.profile;
  Object.assign(form, {
    nickname: profile.nickname ?? '',
    realName: profile.realName ?? '',
    email: profile.email ?? '',
    company: profile.company ?? '',
    title: profile.title ?? '',
    city: profile.city ?? '',
    status: detail.customer.status,
    internalNote: detail.internalNote,
    tags: detail.tags.join('、'),
  });
}

function syncSummary(detail: CustomerAdminDetail) {
  items.value = items.value.map((item) =>
    item.id === detail.customer.id ? summaryAfterUpdate(item, detail) : item,
  );
}

function summaryAfterUpdate(item: CustomerAdminSummary, detail: CustomerAdminDetail) {
  const profile = detail.customer.profile;
  return {
    ...item,
    status: detail.customer.status,
    nickname: profile.nickname,
    realName: profile.realName,
    email: profile.email,
    company: profile.company,
    ...resolveCustomerAdminDisplay(profile, item.latestRegistration),
    lastLoginAt: detail.customer.lastLoginAt,
  };
}

function currentFilters(): CustomerAdminExportQuery {
  return {
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

async function load(targetPage = 1, reuseAppliedFilters = false) {
  const requestId = ++loadRequestId;
  const requestedFilters = reuseAppliedFilters ? { ...appliedFilters.value } : currentFilters();
  loading.value = true;
  exportConfirmation.value = false;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.getCustomers({
      ...requestedFilters,
      page: targetPage,
    });
    if (requestId !== loadRequestId) return;
    items.value = result.items;
    total.value = result.total;
    page.value = result.page;
    totalPages.value = result.totalPages;
    if (!reuseAppliedFilters) appliedFilters.value = requestedFilters;
  } catch (error) {
    if (requestId !== loadRequestId) return;
    errorMessage.value = error instanceof Error ? error.message : '用户列表读取失败';
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false;
    }
  }
}

async function loadAdministrators(force = false) {
  if (!canReadAdministrators.value || (administratorsLoaded.value && !force)) return;
  administratorsLoading.value = true;
  errorMessage.value = '';
  try {
    const [members, invitations] = await Promise.all([
      conferenceApi.getMembers(),
      conferenceApi.getInvitations(),
    ]);
    administrators.value = administratorDirectoryMembers(members);
    administratorInvitations.value = administratorDirectoryInvitations(invitations);
    administratorsLoaded.value = true;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管理员列表读取失败';
  } finally {
    administratorsLoading.value = false;
  }
}

async function switchDirectory(directory: DirectoryKind) {
  activeDirectory.value = directory;
  exportConfirmation.value = false;
  closeMenu();
  if (directory === 'administrators') await loadAdministrators();
}

function resetCreateAccountForm() {
  Object.assign(createCustomerForm, {
    mobile: '',
    nickname: '',
    realName: '',
    email: '',
    company: '',
    title: '',
    city: '',
  });
  Object.assign(createAdministratorForm, { username: '', password: '' });
  createAccountErrorMessage.value = '';
}

async function openCreateAccount(kind: CreateAccountKind, event: MouseEvent) {
  createAccountKind.value = kind;
  createAccountTrigger.value = event.currentTarget as HTMLButtonElement;
  resetCreateAccountForm();
  createAccountOpen.value = true;
  await nextTick();
  if (createAccountDialog.value && !createAccountDialog.value.open) {
    createAccountDialog.value.showModal();
  }
}

async function closeCreateAccount() {
  if (createAccountPending.value) return;
  const trigger = createAccountTrigger.value;
  createAccountDialog.value?.close();
  createAccountOpen.value = false;
  resetCreateAccountForm();
  await nextTick();
  trigger?.focus();
}

function closeCreateAccountFromBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) void closeCreateAccount();
}

async function createCustomer() {
  createAccountPending.value = true;
  createAccountErrorMessage.value = '';
  try {
    administratorLoginUrl.value = '';
    const result = await conferenceApi.createCustomer({
      mobile: createCustomerForm.mobile.trim(),
      nickname: createCustomerForm.nickname.trim() || null,
      realName: createCustomerForm.realName.trim() || null,
      email: createCustomerForm.email.trim() || null,
      company: createCustomerForm.company.trim() || null,
      title: createCustomerForm.title.trim() || null,
      city: createCustomerForm.city.trim() || null,
    });
    createAccountDialog.value?.close();
    createAccountOpen.value = false;
    resetCreateAccountForm();
    activeDirectory.value = 'customers';
    message.value = `用户 ${result.customerId} 已创建。`;
    await load(1);
  } catch (error) {
    createAccountErrorMessage.value = error instanceof Error ? error.message : '用户创建失败';
  } finally {
    createAccountPending.value = false;
  }
}

async function createAdministrator() {
  createAccountPending.value = true;
  createAccountErrorMessage.value = '';
  try {
    const username = createAdministratorForm.username.trim().toLowerCase();
    await conferenceApi.createAdministrator({
      username,
      password: createAdministratorForm.password,
    });
    createAccountDialog.value?.close();
    createAccountOpen.value = false;
    resetCreateAccountForm();
    activeDirectory.value = 'administrators';
    const organizationSlug = session.identity.value?.organization.slug ?? '';
    administratorLoginUrl.value = buildAdministratorLoginUrl(
      window.location.origin,
      import.meta.env.BASE_URL,
      organizationSlug,
    );
    message.value = `管理员 ${username} 已创建，请将当前组织的登录入口和登录凭据安全地交给对方。`;
    await loadAdministrators(true);
  } catch (error) {
    createAccountErrorMessage.value = error instanceof Error ? error.message : '管理员创建失败';
  } finally {
    createAccountPending.value = false;
  }
}

async function copyAdministratorLoginUrl() {
  if (!administratorLoginUrl.value) return;
  try {
    await navigator.clipboard.writeText(administratorLoginUrl.value);
    message.value = '当前组织登录入口已复制。';
  } catch {
    errorMessage.value = '登录入口复制失败，请打开链接后手动复制。';
  }
}

function canManageAdministrator(administrator: OrganizationMember) {
  return (
    isSuperAdministrator.value &&
    administrator.role === 'organization_admin' &&
    administrator.grants.includes('*') &&
    !administrator.isSuperAdministrator &&
    administrator.userId !== session.identity.value?.user.id
  );
}

async function openAdministratorEdit(administrator: OrganizationMember, event: MouseEvent) {
  if (!canManageAdministrator(administrator)) return;
  administratorEditTrigger.value = event.currentTarget as HTMLButtonElement;
  administratorEditTarget.value = administrator;
  Object.assign(editAdministratorForm, {
    username: administrator.username ?? '',
    password: '',
  });
  administratorEditErrorMessage.value = '';
  administratorEditOpen.value = true;
  await nextTick();
  if (administratorEditDialog.value && !administratorEditDialog.value.open) {
    administratorEditDialog.value.showModal();
  }
}

async function closeAdministratorEdit() {
  if (administratorEditPending.value) return;
  const trigger = administratorEditTrigger.value;
  administratorEditDialog.value?.close();
  administratorEditOpen.value = false;
  administratorEditTarget.value = undefined;
  Object.assign(editAdministratorForm, { username: '', password: '' });
  administratorEditErrorMessage.value = '';
  await nextTick();
  trigger?.focus();
}

function closeAdministratorEditFromBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) void closeAdministratorEdit();
}

async function saveAdministratorCredentials() {
  const target = administratorEditTarget.value;
  if (!target || !administratorEditDirty.value) return;
  administratorEditPending.value = true;
  administratorEditErrorMessage.value = '';
  const trigger = administratorEditTrigger.value;
  try {
    administratorLoginUrl.value = '';
    const username = editAdministratorForm.username.trim().toLowerCase();
    const updated = await conferenceApi.updateAdministratorCredentials(target.id, {
      ...(username && username !== (target.username ?? '') ? { username } : {}),
      ...(editAdministratorForm.password ? { password: editAdministratorForm.password } : {}),
    });
    const index = administrators.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) administrators.value[index] = updated;
    administratorEditDialog.value?.close();
    administratorEditOpen.value = false;
    administratorEditTarget.value = undefined;
    Object.assign(editAdministratorForm, { username: '', password: '' });
    message.value = `管理员 ${username || target.username || target.name} 的登录凭据已更新。`;
    await nextTick();
    trigger?.focus();
  } catch (error) {
    administratorEditErrorMessage.value =
      error instanceof Error ? error.message : '管理员登录凭据更新失败';
  } finally {
    administratorEditPending.value = false;
  }
}

function openAdministratorDelete(administrator: OrganizationMember) {
  if (!canManageAdministrator(administrator)) return;
  administratorDeleteTarget.value = administrator;
  administratorDeleteErrorMessage.value = '';
}

function closeAdministratorDelete() {
  if (administratorDeletePending.value) return;
  administratorDeleteTarget.value = undefined;
  administratorDeleteErrorMessage.value = '';
}

async function deleteAdministrator() {
  const target = administratorDeleteTarget.value;
  if (!target) return;
  administratorDeletePending.value = true;
  administratorDeleteErrorMessage.value = '';
  try {
    administratorLoginUrl.value = '';
    await conferenceApi.deleteAdministrator(target.id);
    administrators.value = administrators.value.filter((item) => item.id !== target.id);
    administratorDeleteTarget.value = undefined;
    message.value = `管理员 ${target.username ?? target.name} 已从当前组织删除。`;
  } catch (error) {
    administratorDeleteErrorMessage.value =
      error instanceof Error ? error.message : '管理员删除失败';
  } finally {
    administratorDeletePending.value = false;
  }
}

async function changePage(nextPage: number) {
  if (loading.value || nextPage < 1 || nextPage > totalPages.value || nextPage === page.value)
    return;
  await load(nextPage, true);
  await nextTick();
  customerListHeading.value?.focus({ preventScroll: true });
}

async function clearFilters() {
  filters.q = '';
  filters.status = '';
  await load();
}

async function open(
  item: CustomerAdminSummary,
  event: MouseEvent,
  target: 'profile' | 'settings' | 'history' = 'profile',
) {
  detailTrigger.value = openMenuId.value
    ? menuTrigger.value
    : (event.currentTarget as HTMLButtonElement);
  openMenuId.value = null;
  detailOpen.value = true;
  detailLoading.value = true;
  selected.value = undefined;
  detailMessage.value = '';
  detailErrorMessage.value = '';
  await nextTick();
  if (detailDialog.value && !detailDialog.value.open) detailDialog.value.showModal();
  try {
    const detail = await conferenceApi.getCustomer(item.id);
    selected.value = detail;
    assignForm(detail);
    await nextTick();
    if (target === 'settings')
      document.querySelector<HTMLSelectElement>('#customer-status')?.focus();
    if (target === 'history') registrationHistoryHeading.value?.focus({ preventScroll: false });
  } catch (error) {
    detailErrorMessage.value = error instanceof Error ? error.message : '用户详情读取失败';
  } finally {
    detailLoading.value = false;
  }
}

function toggleMenu(item: CustomerAdminSummary, event: MouseEvent) {
  const trigger = event.currentTarget as HTMLButtonElement;
  if (openMenuId.value === item.id) {
    closeMenu();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const menuWidth = window.innerWidth <= 700 ? 180 : 132;
  const menuItemCount =
    1 + Number(canManage.value && canManageStatus.value) + Number(canDelete.value);
  const menuHeight = 8 + menuItemCount * 36;
  const openUpward = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight;
  menuPosition.top = openUpward ? rect.top - menuHeight - 6 : rect.bottom + 6;
  menuPosition.left = Math.min(
    Math.max(8, rect.right - menuWidth),
    window.innerWidth - menuWidth - 8,
  );
  menuTrigger.value = trigger;
  openMenuId.value = item.id;
}

function closeMenu(focusTrigger = false) {
  openMenuId.value = null;
  if (focusTrigger) void nextTick(() => menuTrigger.value?.focus());
}

function handleMenuFocusOut(event: FocusEvent) {
  const container = event.currentTarget as HTMLElement;
  const next = event.relatedTarget as Node | null;
  if (!next || !container.contains(next)) closeMenu();
}

function handleMenuKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeMenu(true);
}

async function copyUserId(item: CustomerAdminSummary) {
  try {
    await navigator.clipboard.writeText(String(item.id));
    message.value = `已复制“${item.displayName}”的用户 ID。`;
    errorMessage.value = '';
    closeMenu(true);
  } catch {
    errorMessage.value = '用户 ID 复制失败，请稍后重试。';
  }
}

function requestExport() {
  exportQuery.value = { ...appliedFilters.value };
  exportTotal.value = total.value;
  exportConfirmation.value = true;
  message.value = '';
  errorMessage.value = '';
}

async function exportRows() {
  exporting.value = true;
  errorMessage.value = '';
  try {
    const count = await conferenceApi.exportCustomers(exportQuery.value);
    exportConfirmation.value = false;
    message.value = `已按当前筛选导出 ${count} 条用户数据。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '用户数据导出失败';
  } finally {
    exporting.value = false;
  }
}

async function closeDetail() {
  if (pending.value) return;
  const trigger = detailTrigger.value;
  detailDialog.value?.close();
  detailOpen.value = false;
  selected.value = undefined;
  detailMessage.value = '';
  detailErrorMessage.value = '';
  await nextTick();
  trigger?.focus();
}

function closeDetailFromBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) void closeDetail();
}

async function save() {
  if (!selected.value) return;
  pending.value = true;
  detailMessage.value = '';
  detailErrorMessage.value = '';
  try {
    const detail = await conferenceApi.updateCustomer(selected.value.customer.id, {
      profile: {
        version: selected.value.customer.profile.version,
        nickname: form.nickname.trim() || null,
        realName: form.realName.trim() || null,
        email: form.email.trim() || null,
        company: form.company.trim() || null,
        title: form.title.trim() || null,
        city: form.city.trim() || null,
      },
      ...(canManageStatus.value ? { status: form.status } : {}),
      internalNote: form.internalNote.trim(),
      tags: form.tags
        .split(/、|,|，/)
        .map((item) => item.trim())
        .filter(Boolean),
    });
    selected.value = detail;
    assignForm(detail);
    syncSummary(detail);
    detailMessage.value = '用户信息已保存。';
  } catch (error) {
    detailErrorMessage.value = error instanceof Error ? error.message : '用户信息保存失败';
  } finally {
    pending.value = false;
  }
}

async function loadMoreHistory() {
  if (!selected.value?.registrationNextCursor) return;
  historyLoading.value = true;
  detailErrorMessage.value = '';
  try {
    const result = await conferenceApi.getCustomerRegistrations(
      selected.value.customer.id,
      selected.value.registrationNextCursor,
    );
    selected.value = {
      ...selected.value,
      registrations: [...selected.value.registrations, ...result.items],
      registrationNextCursor: result.nextCursor,
    };
  } catch (error) {
    detailErrorMessage.value = error instanceof Error ? error.message : '报名历史读取失败';
  } finally {
    historyLoading.value = false;
  }
}

async function loadMoreInvoices() {
  if (!selected.value?.invoiceNextCursor) return;
  invoiceHistoryLoading.value = true;
  detailErrorMessage.value = '';
  try {
    const result = await conferenceApi.getCustomerInvoices(
      selected.value.customer.id,
      selected.value.invoiceNextCursor,
    );
    selected.value = {
      ...selected.value,
      invoices: [...selected.value.invoices, ...result.items],
      invoiceNextCursor: result.nextCursor,
    };
  } catch (error) {
    detailErrorMessage.value = error instanceof Error ? error.message : '发票历史读取失败';
  } finally {
    invoiceHistoryLoading.value = false;
  }
}

async function moderateShowcase(showcase: CustomerAdminDetail['showcases'][number]) {
  if (!selected.value || !showcase.id || moderationPendingId.value) return;
  const hidden = !showcase.adminHidden;
  const reason = moderationReasons[showcase.id]?.trim() ?? '';
  if (hidden && !reason) {
    detailErrorMessage.value = '下架参会名片时需要填写原因。';
    return;
  }
  moderationPendingId.value = showcase.id;
  detailErrorMessage.value = '';
  try {
    await conferenceApi.moderateAttendeeShowcase(showcase.eventId, showcase.id, {
      hidden,
      reason: hidden ? reason : null,
    });
    selected.value = await conferenceApi.getCustomer(selected.value.customer.id);
    moderationReasons[showcase.id] = '';
    detailMessage.value = hidden ? '参会名片已下架。' : '参会名片已恢复展示资格。';
    await load(page.value, true);
  } catch (error) {
    detailErrorMessage.value = error instanceof Error ? error.message : '参会名片状态更新失败';
  } finally {
    moderationPendingId.value = '';
  }
}

async function requestDelete(item: CustomerAdminSummary, event: MouseEvent) {
  deleteTrigger.value = openMenuId.value
    ? menuTrigger.value
    : (event.currentTarget as HTMLButtonElement);
  openMenuId.value = null;
  deleteTarget.value = item;
  deleteOpen.value = true;
  errorMessage.value = '';
  deleteErrorMessage.value = '';
  await nextTick();
  if (deleteDialog.value && !deleteDialog.value.open) deleteDialog.value.showModal();
}

async function closeDelete() {
  if (deletePending.value) return;
  const trigger = deleteTrigger.value;
  deleteDialog.value?.close();
  deleteOpen.value = false;
  deleteTarget.value = undefined;
  deleteErrorMessage.value = '';
  await nextTick();
  trigger?.focus();
}

function closeDeleteFromBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) void closeDelete();
}

async function removeCustomer() {
  const target = deleteTarget.value;
  if (!target) return;
  const targetName = target.displayName || '当前用户';
  deletePending.value = true;
  deleteErrorMessage.value = '';
  try {
    const result = await conferenceApi.deleteCustomer(target.id);
    deleteDialog.value?.close();
    deleteOpen.value = false;
    deleteTarget.value = undefined;
    const preservedCount = result.detachedRegistrations + result.detachedWaitlistEntries;
    message.value =
      preservedCount > 0
        ? `“${targetName}”已删除，${preservedCount} 条大会历史已保留。`
        : `“${targetName}”已删除。`;
    await load(page.value, true);
    await nextTick();
    customerListHeading.value?.focus({ preventScroll: true });
  } catch (error) {
    deleteErrorMessage.value = error instanceof Error ? error.message : '用户删除失败';
  } finally {
    deletePending.value = false;
  }
}

function closeMenuOnViewportChange() {
  if (openMenuId.value) closeMenu();
}

onMounted(() => {
  void load();
  if (canReadAdministrators.value) void loadAdministrators();
  window.addEventListener('resize', closeMenuOnViewportChange);
  window.addEventListener('scroll', closeMenuOnViewportChange, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', closeMenuOnViewportChange);
  window.removeEventListener('scroll', closeMenuOnViewportChange, true);
});
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">CUSTOMER DIRECTORY</p>
      <h1>用户管理</h1>
      <p>集中维护前台普通用户与后台管理员账号。</p>
    </div>
    <div class="directory-page-actions">
      <span class="status-badge">{{ directoryCountLabel }}</span>
      <button
        v-if="canManage"
        class="button secondary compact"
        type="button"
        @click="openCreateAccount('customer', $event)"
      >
        新增用户
      </button>
      <button
        v-if="canCreateAdministrator"
        class="button compact"
        type="button"
        @click="openCreateAccount('administrator', $event)"
      >
        新增管理员
      </button>
    </div>
  </header>

  <div v-if="message" class="admin-success administrator-create-success" role="status">
    <span>{{ message }}</span>
    <span v-if="administratorLoginUrl">
      <a :href="administratorLoginUrl" target="_blank" rel="noopener noreferrer">打开登录入口</a>
      ·
      <button type="button" @click="copyAdministratorLoginUrl">复制链接</button>
    </span>
  </div>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <nav class="directory-tabs" aria-label="用户目录">
    <button
      class="directory-tab"
      :class="{ active: activeDirectory === 'customers' }"
      type="button"
      :aria-current="activeDirectory === 'customers' ? 'page' : undefined"
      @click="switchDirectory('customers')"
    >
      <span>普通用户</span>
      <b>{{ total }}</b>
    </button>
    <button
      v-if="canReadAdministrators"
      class="directory-tab"
      :class="{ active: activeDirectory === 'administrators' }"
      type="button"
      :aria-current="activeDirectory === 'administrators' ? 'page' : undefined"
      @click="switchDirectory('administrators')"
    >
      <span>管理员</span>
      <b>{{ administrators.length }}</b>
    </button>
  </nav>

  <section v-if="activeDirectory === 'customers'" class="admin-panel customer-list-panel">
    <header class="admin-panel-header">
      <div>
        <h2 ref="customerListHeading" tabindex="-1">全部普通用户</h2>
        <p>完整显示登录手机号，可按姓名、公司、邮箱、手机号或数字用户 ID 检索</p>
      </div>
      <div class="customer-list-tools">
        <form class="customer-filters" @submit.prevent="load()">
          <input
            v-model="filters.q"
            type="search"
            placeholder="搜索姓名、手机号或用户 ID"
            aria-label="搜索用户"
          />
          <select v-model="filters.status" aria-label="账号状态">
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="blocked">已封禁</option>
            <option value="closed">已关闭</option>
          </select>
          <button class="button secondary compact" type="submit">筛选</button>
          <button
            v-if="hasFilters"
            class="button secondary compact"
            type="button"
            @click="clearFilters"
          >
            清空
          </button>
        </form>
        <button
          v-if="canExport"
          class="button secondary compact customer-export-button"
          type="button"
          :disabled="loading || total === 0 || exporting"
          @click="requestExport"
        >
          导出当前结果
        </button>
      </div>
    </header>
    <section
      v-if="exportConfirmation"
      class="customer-export-confirm"
      aria-labelledby="customer-export-title"
    >
      <div>
        <strong id="customer-export-title">导出当前筛选的 {{ exportTotal }} 条用户数据</strong>
        <p>文件包含完整手机号、用户资料和最新报名信息，导出操作会记录审计日志。</p>
      </div>
      <div>
        <button
          class="button secondary compact"
          type="button"
          :disabled="exporting"
          @click="exportConfirmation = false"
        >
          取消
        </button>
        <button class="button compact" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '正在准备文件…' : '确认导出' }}
        </button>
      </div>
    </section>
    <div v-if="loading" class="admin-loading">正在载入用户…</div>
    <div v-else class="data-table-wrap">
      <table class="data-table customer-table">
        <caption class="sr-only">
          普通用户列表
        </caption>
        <thead>
          <tr>
            <th class="customer-id-column">用户 ID</th>
            <th>手机号</th>
            <th>姓名</th>
            <th>公司</th>
            <th>账号注册时间</th>
            <th class="customer-registration-column">报名记录</th>
            <th>参会名片</th>
            <th>最新报名大会</th>
            <th class="customer-status-column">状态</th>
            <th class="customer-actions-column">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="customer-id-cell customer-id-column" data-label="用户 ID">
              <button
                class="customer-copy-value"
                type="button"
                :title="`复制用户 ID：${item.id}`"
                :aria-label="`复制${item.displayName}的用户 ID`"
                @click="copyUserId(item)"
              >
                {{ item.id }}
              </button>
            </td>
            <td class="customer-mobile-cell" data-label="手机号">
              <span class="row-title">{{ domesticMobile(item.mobile) }}</span>
            </td>
            <td class="customer-name-cell" data-label="姓名">
              <span class="row-title customer-sourced-value">
                {{ item.displayName }}
                <small v-if="item.displayNameSource === 'registration'">来自最近报名</small>
              </span>
            </td>
            <td class="customer-company-cell" data-label="公司">
              <span class="customer-sourced-value">
                {{ item.displayCompany }}
                <small v-if="item.displayCompanySource === 'registration'">来自最近报名</small>
              </span>
            </td>
            <td class="customer-created-cell" data-label="账号注册时间">
              {{ date(item.createdAt) }}
            </td>
            <td
              class="customer-registration-count customer-registration-column"
              data-label="报名记录"
            >
              {{ item.registrationsCount }}
              <span class="row-sub">{{ item.eventCount }} 场大会</span>
            </td>
            <td data-label="参会名片">
              <span class="row-title">{{ item.showcaseCount }}</span>
              <span class="row-sub">{{ item.publicShowcaseCount }} 张公开</span>
            </td>
            <td class="customer-latest-cell" data-label="最新报名大会">
              <button
                v-if="item.latestRegistration"
                class="customer-latest-registration"
                type="button"
                :aria-label="`查看${item.displayName}在${item.latestRegistration.eventName}的报名记录`"
                @click="open(item, $event, 'history')"
              >
                <strong>{{ item.latestRegistration.eventName }}</strong>
                <span>
                  {{ registrationStatus(item.latestRegistration.registrationStatus) }}
                  · {{ date(item.latestRegistration.createdAt) }}
                </span>
              </button>
              <span v-else class="customer-empty-value">暂无报名</span>
            </td>
            <td class="customer-status-column" data-label="状态">
              <span class="status-badge" :class="item.status === 'active' ? 'paid' : 'failed'">
                {{ statusLabel[item.status] }}
              </span>
            </td>
            <td
              class="customer-actions-column"
              :class="{ 'menu-open': openMenuId === item.id }"
              data-label="操作"
            >
              <div class="customer-row-actions">
                <button class="button secondary compact" type="button" @click="open(item, $event)">
                  {{ canManage ? '编辑' : '查看' }}
                </button>
                <div
                  class="customer-more"
                  @focusout="handleMenuFocusOut"
                  @keydown="handleMenuKeydown"
                >
                  <button
                    class="button secondary compact"
                    type="button"
                    :aria-expanded="openMenuId === item.id"
                    :aria-controls="`customer-more-${item.id}`"
                    @click="toggleMenu(item, $event)"
                  >
                    更多
                  </button>
                  <div
                    v-if="openMenuId === item.id"
                    :id="`customer-more-${item.id}`"
                    class="customer-more-menu"
                    role="group"
                    :aria-label="`${item.displayName}的更多操作`"
                    :style="{ top: `${menuPosition.top}px`, left: `${menuPosition.left}px` }"
                  >
                    <button
                      v-if="canManage && canManageStatus"
                      type="button"
                      @click="open(item, $event, 'settings')"
                    >
                      账号设置
                    </button>
                    <button type="button" @click="copyUserId(item)">复制用户 ID</button>
                    <button
                      v-if="canDelete"
                      class="danger"
                      type="button"
                      @click="requestDelete(item, $event)"
                    >
                      删除用户
                    </button>
                  </div>
                </div>
              </div>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="9" class="admin-empty">当前筛选条件下没有普通用户。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer v-if="total > 20" class="customer-pagination">
      <span>{{ visibleRange }}</span>
      <nav aria-label="普通用户分页">
        <button
          class="page-arrow"
          type="button"
          aria-label="上一页"
          :disabled="page === 1 || loading"
          @click="changePage(page - 1)"
        >
          ‹
        </button>
        <template v-for="(item, index) in paginationItems" :key="`${item}-${index}`">
          <span v-if="item === 'ellipsis'" class="page-ellipsis" aria-hidden="true">…</span>
          <button
            v-else
            class="page-number"
            :class="{ active: item === page }"
            type="button"
            :aria-current="item === page ? 'page' : undefined"
            :aria-label="`第 ${item} 页`"
            :disabled="loading"
            @click="changePage(item)"
          >
            {{ item }}
          </button>
        </template>
        <button
          class="page-arrow"
          type="button"
          aria-label="下一页"
          :disabled="page === totalPages || loading"
          @click="changePage(page + 1)"
        >
          ›
        </button>
      </nav>
    </footer>
  </section>

  <section v-else class="admin-panel administrator-list-panel">
    <header class="admin-panel-header">
      <div>
        <h2>全部管理员</h2>
        <p>显示可进入后台的组织成员、角色和当前访问状态</p>
      </div>
    </header>

    <section
      v-if="pendingAdministratorInvitations.length"
      class="administrator-pending"
      aria-labelledby="administrator-pending-title"
    >
      <div>
        <strong id="administrator-pending-title">
          {{ pendingAdministratorInvitations.length }} 个邀请待接受
        </strong>
        <p>对方完成账号设置后会自动进入管理员列表。</p>
      </div>
      <ul>
        <li v-for="invitation in pendingAdministratorInvitations" :key="invitation.id">
          <span>{{ invitation.email }}</span>
          <small>{{ date(invitation.expiresAt) }} 到期</small>
        </li>
      </ul>
    </section>

    <div v-if="administratorsLoading" class="admin-loading">正在载入管理员…</div>
    <div v-else class="data-table-wrap">
      <table class="data-table administrator-table">
        <caption class="sr-only">
          管理员列表
        </caption>
        <thead>
          <tr>
            <th>用户 ID</th>
            <th>管理员</th>
            <th>手机号</th>
            <th>角色</th>
            <th>公司与职位</th>
            <th>状态</th>
            <th v-if="isSuperAdministrator">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="administrator in administrators" :key="administrator.id">
            <td class="administrator-id" data-label="用户 ID">{{ administrator.userId }}</td>
            <td data-label="管理员">
              <span class="row-title">
                {{ administrator.name }}
                <small v-if="administrator.userId === session.identity.value?.user.id">你</small>
              </span>
              <span class="row-sub">
                {{
                  administrator.username
                    ? `用户名：${administrator.username}`
                    : administrator.email || '未填写邮箱'
                }}
              </span>
            </td>
            <td data-label="手机号">{{ domesticMobile(administrator.mobile) || '未填写' }}</td>
            <td data-label="角色">
              <span class="status-badge">
                {{
                  administrator.isSuperAdministrator
                    ? '超级管理员'
                    : organizationRoleLabel(administrator.role)
                }}
              </span>
            </td>
            <td data-label="公司与职位">
              {{ administrator.profile?.company || '未填写' }}
              <span v-if="administrator.profile?.title" class="row-sub">
                {{ administrator.profile.title }}
              </span>
            </td>
            <td data-label="状态">
              <span
                class="status-badge"
                :class="administrator.status === 'active' ? 'paid' : 'draft'"
              >
                {{ administrator.status === 'active' ? '已启用' : '已停用' }}
              </span>
            </td>
            <td v-if="isSuperAdministrator" data-label="操作">
              <div v-if="canManageAdministrator(administrator)" class="administrator-actions">
                <button
                  class="button secondary compact"
                  type="button"
                  @click="openAdministratorEdit(administrator, $event)"
                >
                  编辑
                </button>
                <button
                  class="button danger compact"
                  type="button"
                  @click="openAdministratorDelete(administrator)"
                >
                  删除
                </button>
              </div>
              <span v-else class="administrator-protected">受保护</span>
            </td>
          </tr>
          <tr v-if="!administrators.length">
            <td :colspan="isSuperAdministrator ? 7 : 6" class="admin-empty">
              当前没有可显示的管理员。
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <dialog
    v-if="administratorEditOpen && administratorEditTarget"
    ref="administratorEditDialog"
    class="account-create-dialog administrator-credential-dialog"
    aria-labelledby="administrator-edit-title"
    aria-describedby="administrator-edit-description"
    @cancel.prevent="closeAdministratorEdit"
    @click="closeAdministratorEditFromBackdrop"
  >
    <header>
      <div>
        <p class="eyebrow">EDIT ADMINISTRATOR</p>
        <h2 id="administrator-edit-title">编辑管理员</h2>
        <p id="administrator-edit-description">
          修改 {{ administratorEditTarget.name }} 的用户名，或为其设置新的登录密码。
        </p>
      </div>
      <button
        class="customer-detail-close"
        type="button"
        :disabled="administratorEditPending"
        @click="closeAdministratorEdit"
      >
        <span aria-hidden="true">×</span>关闭
      </button>
    </header>

    <form
      id="administrator-edit-form"
      class="account-create-form"
      @submit.prevent="saveAdministratorCredentials"
    >
      <div class="administrator-credential-summary">
        <span>当前账号</span>
        <strong>
          {{
            administratorEditTarget.username
              ? `@${administratorEditTarget.username}`
              : administratorEditTarget.email
          }}
        </strong>
      </div>
      <div class="form-grid">
        <div class="form-field full">
          <label for="administrator-edit-username">管理员用户名（可选）</label>
          <input
            id="administrator-edit-username"
            v-model="editAdministratorForm.username"
            type="text"
            autocomplete="off"
            minlength="3"
            maxlength="32"
            pattern="[A-Za-z][A-Za-z0-9_-]*"
            placeholder="例如：operations"
          />
          <small>留空会保留当前登录账号；填写新用户名后，该账号需使用新用户名登录。</small>
        </div>
        <div class="form-field full">
          <label for="administrator-edit-password">新登录密码</label>
          <input
            id="administrator-edit-password"
            v-model="editAdministratorForm.password"
            type="password"
            autocomplete="new-password"
            minlength="8"
            maxlength="72"
            placeholder="留空则保持原密码"
          />
          <small>可留空。填写时需为 8～72 个 UTF-8 字节，保存后立即生效。</small>
        </div>
      </div>
      <p class="administrator-credential-note">
        如果该账号加入了多个组织，本次修改会同步更新所有组织的登录用户名或密码。
      </p>
    </form>

    <p v-if="administratorEditErrorMessage" class="admin-error" role="alert">
      {{ administratorEditErrorMessage }}
    </p>

    <footer>
      <button
        class="button secondary"
        type="button"
        :disabled="administratorEditPending"
        @click="closeAdministratorEdit"
      >
        取消
      </button>
      <button
        class="button"
        type="submit"
        form="administrator-edit-form"
        :disabled="administratorEditPending || !administratorEditDirty"
      >
        {{ administratorEditPending ? '正在保存…' : '保存登录凭据' }}
      </button>
    </footer>
  </dialog>

  <dialog
    v-if="createAccountOpen"
    ref="createAccountDialog"
    class="account-create-dialog"
    :aria-labelledby="
      createAccountKind === 'customer' ? 'create-customer-title' : 'create-administrator-title'
    "
    @cancel.prevent="closeCreateAccount"
    @click="closeCreateAccountFromBackdrop"
  >
    <header>
      <div>
        <p class="eyebrow">
          {{ createAccountKind === 'customer' ? 'NEW CUSTOMER' : 'NEW ADMINISTRATOR' }}
        </p>
        <h2
          :id="
            createAccountKind === 'customer'
              ? 'create-customer-title'
              : 'create-administrator-title'
          "
        >
          {{ createAccountKind === 'customer' ? '新增普通用户' : '新增管理员' }}
        </h2>
        <p>
          {{
            createAccountKind === 'customer'
              ? '创建可使用手机验证码登录的前台账号。'
              : '设置登录凭据，直接创建完整权限的组织管理员。'
          }}
        </p>
      </div>
      <button
        class="customer-detail-close"
        type="button"
        :disabled="createAccountPending"
        @click="closeCreateAccount"
      >
        <span aria-hidden="true">×</span>关闭
      </button>
    </header>

    <form
      v-if="createAccountKind === 'customer'"
      id="create-customer-form"
      class="account-create-form"
      @submit.prevent="createCustomer"
    >
      <div class="form-grid">
        <div class="form-field full">
          <label for="create-customer-mobile">登录手机号</label>
          <input
            id="create-customer-mobile"
            v-model="createCustomerForm.mobile"
            type="tel"
            inputmode="tel"
            autocomplete="off"
            required
            placeholder="13800138000"
          />
          <small>中国大陆手机号，用户首次登录时仍需通过短信验证码。</small>
        </div>
        <div class="form-field">
          <label for="create-customer-real-name">真实姓名</label>
          <input
            id="create-customer-real-name"
            v-model="createCustomerForm.realName"
            maxlength="120"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
        <div class="form-field">
          <label for="create-customer-nickname">用户名</label>
          <input
            id="create-customer-nickname"
            v-model="createCustomerForm.nickname"
            maxlength="80"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
        <div class="form-field">
          <label for="create-customer-email">邮箱</label>
          <input
            id="create-customer-email"
            v-model="createCustomerForm.email"
            type="email"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
        <div class="form-field">
          <label for="create-customer-company">公司</label>
          <input
            id="create-customer-company"
            v-model="createCustomerForm.company"
            maxlength="160"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
        <div class="form-field">
          <label for="create-customer-title">职位</label>
          <input
            id="create-customer-title"
            v-model="createCustomerForm.title"
            maxlength="100"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
        <div class="form-field">
          <label for="create-customer-city">城市</label>
          <input
            id="create-customer-city"
            v-model="createCustomerForm.city"
            maxlength="80"
            autocomplete="off"
            placeholder="可留空"
          />
        </div>
      </div>
    </form>

    <form
      v-else
      id="create-administrator-form"
      class="account-create-form"
      @submit.prevent="createAdministrator"
    >
      <div class="form-grid">
        <div class="form-field full">
          <label for="create-administrator-username">管理员用户名</label>
          <input
            id="create-administrator-username"
            v-model="createAdministratorForm.username"
            type="text"
            autocomplete="off"
            minlength="3"
            maxlength="32"
            pattern="[A-Za-z][A-Za-z0-9_-]*"
            required
            placeholder="例如：operations"
          />
          <small>3～32 个字符，以字母开头，可使用字母、数字、下划线和短横线。</small>
        </div>
        <div class="form-field full">
          <label for="create-administrator-password">登录密码</label>
          <input
            id="create-administrator-password"
            v-model="createAdministratorForm.password"
            type="password"
            autocomplete="new-password"
            minlength="8"
            maxlength="72"
            required
            placeholder="至少 8 个字符"
          />
          <small>8～72 个 UTF-8 字节，创建后立即生效，请通过安全方式告知管理员。</small>
        </div>
      </div>
    </form>

    <p v-if="createAccountErrorMessage" class="admin-error" role="alert">
      {{ createAccountErrorMessage }}
    </p>

    <footer>
      <button
        class="button secondary"
        type="button"
        :disabled="createAccountPending"
        @click="closeCreateAccount"
      >
        取消
      </button>
      <button
        class="button"
        type="submit"
        :form="
          createAccountKind === 'customer' ? 'create-customer-form' : 'create-administrator-form'
        "
        :disabled="createAccountPending"
      >
        {{
          createAccountPending
            ? '正在创建…'
            : createAccountKind === 'customer'
              ? '创建用户'
              : '创建管理员'
        }}
      </button>
    </footer>
  </dialog>

  <dialog
    v-if="detailOpen"
    ref="detailDialog"
    class="customer-detail-dialog"
    aria-labelledby="customer-detail-title"
    aria-describedby="customer-detail-description"
    @cancel.prevent="closeDetail"
    @click="closeDetailFromBackdrop"
  >
    <header>
      <div>
        <p class="eyebrow">CUSTOMER DETAIL</p>
        <h2 id="customer-detail-title">{{ selectedName }}</h2>
        <p id="customer-detail-description">查看账号资料、登录状态、报名历史和发票记录</p>
      </div>
      <button
        class="customer-detail-close"
        type="button"
        aria-label="关闭用户详情"
        title="关闭"
        :disabled="pending"
        @click="closeDetail"
      >
        <span aria-hidden="true">×</span>关闭
      </button>
    </header>

    <div v-if="detailLoading" class="customer-dialog-loading">
      <div class="admin-loading">正在载入用户详情…</div>
    </div>

    <template v-else-if="selected">
      <div class="customer-detail-scroll">
        <p v-if="detailMessage" class="admin-success" role="status">{{ detailMessage }}</p>
        <p v-if="detailErrorMessage" class="admin-error" role="alert">
          {{ detailErrorMessage }}
        </p>

        <section class="customer-account-summary" aria-label="账号概览">
          <div>
            <span>登录手机号</span>
            <strong>{{ domesticMobile(selected.customer.mobile) }}</strong>
            <small>组织内唯一账号</small>
          </div>
          <div>
            <span>登录方式</span>
            <strong>手机验证码</strong>
            <small>验证通过后自动登录或注册</small>
          </div>
          <div>
            <span>用户 ID</span>
            <strong>{{ selected.customer.id }}</strong>
            <small>系统统一数字标识</small>
          </div>
          <div>
            <span>最近登录</span>
            <strong>{{ date(selected.customer.lastLoginAt) }}</strong>
            <small>注册于 {{ date(selected.customer.createdAt) }}</small>
          </div>
        </section>

        <section class="customer-detail-section">
          <div class="customer-section-heading">
            <div>
              <p class="settings-module-kicker">PROFILE</p>
              <h3>用户资料</h3>
            </div>
            <span
              class="status-badge"
              :class="selected.customer.status === 'active' ? 'paid' : 'failed'"
            >
              {{ statusLabel[selected.customer.status] }}
            </span>
          </div>

          <form
            v-if="canManage"
            id="customer-detail-form"
            class="customer-detail-form"
            @submit.prevent="save"
          >
            <div class="form-grid">
              <div class="form-field">
                <label for="customer-nickname">用户名</label>
                <input
                  id="customer-nickname"
                  v-model="form.nickname"
                  maxlength="80"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-real-name">真实姓名</label>
                <input
                  id="customer-real-name"
                  v-model="form.realName"
                  maxlength="120"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-email">邮箱</label>
                <input
                  id="customer-email"
                  v-model="form.email"
                  type="email"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-company">公司</label>
                <input
                  id="customer-company"
                  v-model="form.company"
                  maxlength="160"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-title">职位</label>
                <input
                  id="customer-title"
                  v-model="form.title"
                  maxlength="100"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-city">城市</label>
                <input
                  id="customer-city"
                  v-model="form.city"
                  maxlength="80"
                  autocomplete="off"
                  placeholder="可留空"
                />
              </div>
              <div class="form-field">
                <label for="customer-status">账号状态</label>
                <select id="customer-status" v-model="form.status" :disabled="!canManageStatus">
                  <option value="active">正常</option>
                  <option value="blocked">封禁登录</option>
                  <option value="closed">关闭账号</option>
                </select>
              </div>
              <div class="form-field">
                <label for="customer-tags">标签</label>
                <input
                  id="customer-tags"
                  v-model="form.tags"
                  autocomplete="off"
                  placeholder="嘉宾、VIP、媒体"
                />
              </div>
              <div class="form-field full">
                <label for="customer-note">内部备注</label>
                <textarea
                  id="customer-note"
                  v-model="form.internalNote"
                  rows="3"
                  maxlength="2000"
                  placeholder="仅后台人员可见"
                />
              </div>
            </div>
          </form>

          <dl v-else class="customer-readonly-profile">
            <div>
              <dt>用户名</dt>
              <dd>{{ selected.customer.profile.nickname || '未填写' }}</dd>
            </div>
            <div>
              <dt>真实姓名</dt>
              <dd>{{ selected.customer.profile.realName || '未填写' }}</dd>
            </div>
            <div>
              <dt>邮箱</dt>
              <dd>{{ selected.customer.profile.email || '未填写' }}</dd>
            </div>
            <div>
              <dt>公司</dt>
              <dd>{{ selected.customer.profile.company || '未填写' }}</dd>
            </div>
            <div>
              <dt>职位</dt>
              <dd>{{ selected.customer.profile.title || '未填写' }}</dd>
            </div>
            <div>
              <dt>城市</dt>
              <dd>{{ selected.customer.profile.city || '未填写' }}</dd>
            </div>
          </dl>
        </section>

        <section class="customer-detail-section">
          <div class="customer-section-heading">
            <div>
              <p class="settings-module-kicker">ATTENDEE PROFILES</p>
              <h3>参会名片</h3>
            </div>
            <span class="customer-record-count">{{ selected.showcases.length }} 张</span>
          </div>

          <div v-if="selected.showcases.length" class="admin-showcase-list">
            <article
              v-for="showcase in selected.showcases"
              :key="showcase.id ?? showcase.registrationId"
            >
              <header>
                <div>
                  <span>NO.{{ String(showcase.sequence ?? 0).padStart(3, '0') }}</span>
                  <h4>{{ showcase.eventName }}</h4>
                  <p>
                    {{ showcase.displayName || '姓名未填写' }} ·
                    {{ showcase.company || '公司未填写' }}
                  </p>
                </div>
                <span
                  class="status-badge"
                  :class="showcase.effectivePublic ? 'paid' : showcase.adminHidden ? 'failed' : ''"
                >
                  {{
                    showcase.effectivePublic ? '公开中' : showcase.adminHidden ? '已下架' : '未公开'
                  }}
                </span>
              </header>
              <dl>
                <div>
                  <dt>完成度</dt>
                  <dd>{{ showcase.completion.score }}%</dd>
                </div>
                <div>
                  <dt>行业</dt>
                  <dd>{{ showcase.industryCode || '未选择' }}</dd>
                </div>
                <div>
                  <dt>授权时间</dt>
                  <dd>{{ date(showcase.consentAt) }}</dd>
                </div>
                <div>
                  <dt>资格状态</dt>
                  <dd>
                    {{ showcase.qualified ? '有效' : showcase.qualificationReason || '无效' }}
                  </dd>
                </div>
              </dl>
              <div class="admin-showcase-fields">
                <span
                  v-for="(enabled, field) in showcase.visibleFields"
                  :key="field"
                  :class="{ enabled }"
                >
                  {{ showcaseFieldLabels[field] || field }} · {{ enabled ? '公开' : '隐藏' }}
                </span>
              </div>
              <p v-if="showcase.businessIntro" class="admin-showcase-intro">
                {{ showcase.businessIntro }}
              </p>
              <div class="admin-showcase-links">
                <a
                  v-if="showcase.effectivePublic && showcasePath(showcase)"
                  :href="showcasePath(showcase)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开公开预览
                </a>
                <code v-if="showcasePath(showcase)">{{ showcasePath(showcase) }}</code>
              </div>
              <div v-if="canManage && showcase.id" class="admin-showcase-moderation">
                <template v-if="!showcase.adminHidden">
                  <input
                    v-model="moderationReasons[showcase.id]"
                    maxlength="500"
                    placeholder="填写下架原因，用户可在个人中心看到"
                  />
                  <button
                    class="button danger compact"
                    type="button"
                    :disabled="Boolean(moderationPendingId)"
                    @click="moderateShowcase(showcase)"
                  >
                    {{ moderationPendingId === showcase.id ? '正在下架…' : '下架名片' }}
                  </button>
                </template>
                <template v-else>
                  <p>下架原因：{{ showcase.adminHiddenReason || '未填写' }}</p>
                  <button
                    class="button secondary compact"
                    type="button"
                    :disabled="Boolean(moderationPendingId)"
                    @click="moderateShowcase(showcase)"
                  >
                    {{ moderationPendingId === showcase.id ? '正在恢复…' : '恢复名片' }}
                  </button>
                </template>
              </div>
            </article>
          </div>
          <p v-else class="admin-empty">该用户还没有完善过参会名片。</p>
        </section>

        <div class="customer-history-grid">
          <section class="customer-detail-section">
            <div class="customer-section-heading">
              <div>
                <p class="settings-module-kicker">REGISTRATIONS</p>
                <h3 ref="registrationHistoryHeading" tabindex="-1">报名历史</h3>
              </div>
              <span class="customer-record-count">
                {{ selectedSummary?.registrationsCount ?? selected.registrations.length }} 条
              </span>
            </div>
            <ul class="customer-history-list">
              <li v-for="registration in selected.registrations" :key="registration.id">
                <span>
                  <strong>{{ registration.eventName }}</strong>
                  <small>{{ registration.ticketTypeName }} · {{ registration.orderNo }}</small>
                </span>
                <span>
                  <b>{{ registrationStatus(registration.registrationStatus) }}</b>
                  <small>{{ date(registration.createdAt) }}</small>
                </span>
              </li>
              <li v-if="!selected.registrations.length" class="admin-empty">暂无报名历史。</li>
            </ul>
            <button
              v-if="selected.registrationNextCursor"
              class="button secondary compact history-more"
              type="button"
              :disabled="historyLoading"
              @click="loadMoreHistory"
            >
              {{ historyLoading ? '正在加载…' : '加载更多报名' }}
            </button>
          </section>

          <section class="customer-detail-section">
            <div class="customer-section-heading">
              <div>
                <p class="settings-module-kicker">INVOICES</p>
                <h3>发票记录</h3>
              </div>
              <span class="customer-record-count">
                {{ selectedSummary?.invoiceCount ?? selected.invoices.length }} 条
              </span>
            </div>
            <ul class="customer-history-list">
              <li v-for="invoice in selected.invoices" :key="invoice.id">
                <span>
                  <strong>{{ invoice.eventName }}</strong>
                  <small>{{ invoice.requestNo }} · {{ invoice.title || '待补资料' }}</small>
                </span>
                <span>
                  <b>{{ invoiceStatusLabel[invoice.status] || invoice.status }}</b>
                  <small>{{ money(invoice.amount) }}</small>
                </span>
              </li>
              <li v-if="!selected.invoices.length" class="admin-empty">暂无发票记录。</li>
            </ul>
            <button
              v-if="selected.invoiceNextCursor"
              class="button secondary compact history-more"
              type="button"
              :disabled="invoiceHistoryLoading"
              @click="loadMoreInvoices"
            >
              {{ invoiceHistoryLoading ? '正在加载…' : '加载更多发票' }}
            </button>
          </section>
        </div>
      </div>

      <footer class="customer-detail-actions">
        <p v-if="canManage">手机号作为登录账号，当前页面不支持更换。</p>
        <span v-else></span>
        <div>
          <button class="button secondary" type="button" :disabled="pending" @click="closeDetail">
            关闭
          </button>
          <button
            v-if="canManage"
            class="button"
            type="submit"
            form="customer-detail-form"
            :disabled="pending"
          >
            {{ pending ? '保存中…' : '保存用户信息' }}
          </button>
        </div>
      </footer>
    </template>

    <template v-else>
      <div class="customer-dialog-error">
        <p class="admin-error" role="alert">
          {{ detailErrorMessage || '用户详情暂时无法读取。' }}
        </p>
      </div>
      <footer class="customer-detail-actions">
        <span></span>
        <button class="button secondary" type="button" @click="closeDetail">关闭</button>
      </footer>
    </template>
  </dialog>

  <dialog
    v-if="deleteOpen && deleteTarget"
    ref="deleteDialog"
    class="customer-delete-dialog"
    aria-labelledby="customer-delete-title"
    aria-describedby="customer-delete-description"
    @cancel.prevent="closeDelete"
    @click="closeDeleteFromBackdrop"
  >
    <div class="customer-delete-icon" aria-hidden="true">!</div>
    <div>
      <p class="eyebrow">DELETE CUSTOMER</p>
      <h2 id="customer-delete-title">确认删除这个用户？</h2>
    </div>
    <div class="customer-delete-target">
      <strong>{{ deleteTargetName }}</strong>
      <span>{{ domesticMobile(deleteTarget.mobile) }}</span>
    </div>
    <p id="customer-delete-description">
      删除后当前账号会立即失效。此手机号再次验证时会创建新账号，原报名历史不会自动关联。报名、订单、发票和候补记录会保留在对应大会中。此操作无法撤销。
    </p>
    <p v-if="deleteErrorMessage" class="admin-error" role="alert">
      {{ deleteErrorMessage }}
    </p>
    <footer>
      <button class="button secondary" type="button" :disabled="deletePending" @click="closeDelete">
        取消
      </button>
      <button class="button danger" type="button" :disabled="deletePending" @click="removeCustomer">
        {{ deletePending ? '正在删除…' : '确认删除用户' }}
      </button>
    </footer>
  </dialog>

  <AdminConfirmDialog
    :open="Boolean(administratorDeleteTarget)"
    title="确认删除这个管理员？"
    description="删除后，该账号会立即失去当前组织的后台访问权限。账号在其他组织的权限和登录凭据会保留。"
    confirm-label="确认删除管理员"
    cancel-label="取消"
    tone="danger"
    :busy="administratorDeletePending"
    :error="administratorDeleteErrorMessage"
    :details="administratorDeleteDetails"
    @confirm="deleteAdministrator"
    @cancel="closeAdministratorDelete"
  />
</template>

<style scoped>
.administrator-create-success {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.administrator-create-success a,
.administrator-create-success button {
  color: inherit;
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.administrator-create-success button {
  padding: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.directory-page-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.directory-tabs {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  margin: 0 0 12px;
  border-bottom: 1px solid var(--line);
}

.directory-tab {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition:
    color 140ms ease-out,
    border-color 140ms ease-out;
}

.directory-tab b {
  min-width: 22px;
  padding: 2px 6px;
  color: var(--muted);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.directory-tab.active {
  color: var(--blue);
  border-bottom-color: var(--blue);
}

.directory-tab.active b {
  color: var(--blue);
  background: var(--blue-soft);
  border-color: transparent;
}

.customer-list-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.customer-filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.customer-filters input,
.customer-filters select {
  min-height: var(--admin-control-height);
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
}

.customer-filters input {
  width: 190px;
  padding: 0 10px;
}

.customer-filters select {
  padding: 0 26px 0 9px;
}

.customer-export-button {
  flex: 0 0 auto;
}

.customer-export-confirm {
  display: flex;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 18px;
  background: var(--blue-soft);
  border-bottom: 1px solid var(--line);
}

.customer-export-confirm strong {
  color: var(--ink);
  font-size: 12px;
}

.customer-export-confirm p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 10px;
}

.customer-export-confirm > div:last-child {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.customer-table {
  min-width: 1100px;
}

.customer-table th,
.customer-table td {
  padding-inline: 12px;
}

.customer-id-cell,
.customer-mobile-cell,
.customer-created-cell,
.customer-actions-column {
  white-space: nowrap;
}

.customer-id-cell {
  width: 92px;
}

.customer-id-column,
.customer-registration-column,
.customer-status-column,
.customer-actions-column {
  text-align: center;
}

.customer-mobile-cell {
  width: 118px;
  font-variant-numeric: tabular-nums;
}

.customer-name-cell {
  width: 136px;
}

.customer-company-cell {
  width: 132px;
}

.customer-created-cell {
  width: 132px;
  font-variant-numeric: tabular-nums;
}

.customer-registration-count {
  width: 82px;
}

.customer-latest-cell {
  min-width: 210px;
}

.customer-actions-column {
  position: sticky;
  right: 0;
  z-index: 3;
  width: 132px;
  min-width: 132px;
  background: #fff;
  box-shadow: -10px 0 16px -16px rgb(23 34 51 / 55%);
}

.customer-table th.customer-actions-column {
  z-index: 4;
  background: var(--paper);
}

.customer-actions-column.menu-open {
  z-index: 5;
}

.customer-copy-value,
.customer-latest-registration {
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  font: inherit;
  text-align: left;
}

.customer-copy-value {
  width: 100%;
  min-height: 40px;
  color: var(--blue);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

.customer-copy-value:hover,
.customer-copy-value:focus-visible,
.customer-latest-registration:hover strong,
.customer-latest-registration:focus-visible strong {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.customer-sourced-value {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.customer-sourced-value small {
  flex: 0 0 auto;
  padding: 2px 4px;
  color: var(--blue);
  background: var(--blue-soft);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.customer-latest-registration {
  width: 100%;
  min-height: 40px;
  display: grid;
  align-content: center;
  gap: 4px;
}

.customer-latest-registration strong,
.customer-latest-registration span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.customer-latest-registration strong {
  color: var(--ink);
  font-size: 11px;
}

.customer-latest-registration span,
.customer-empty-value {
  color: var(--muted);
  font-size: 10px;
}

.customer-registration-column {
  font-variant-numeric: tabular-nums;
}

.customer-registration-column .row-sub {
  text-align: center;
}

.customer-row-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.customer-more {
  position: relative;
}

.customer-more-menu {
  position: fixed;
  z-index: 160;
  width: 132px;
  overflow: hidden;
  padding: 4px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 12px 30px rgb(23 34 51 / 18%);
}

.customer-more-menu button {
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  padding: 0 9px;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-radius: 4px;
  font: inherit;
  font-size: 10px;
  text-align: left;
}

.customer-more-menu button:hover,
.customer-more-menu button:focus-visible {
  background: var(--blue-soft);
}

.customer-more-menu button.danger {
  color: var(--red);
}

.customer-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  border-top: 1px solid var(--line);
}

.customer-pagination nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.customer-pagination .page-arrow,
.customer-pagination .page-number {
  min-width: 40px;
  min-height: 40px;
  height: 40px;
  padding: 0 8px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}

.customer-pagination .page-number.active {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
}

.customer-pagination button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.customer-pagination .page-ellipsis {
  min-width: 24px;
  text-align: center;
}

.administrator-pending {
  display: grid;
  grid-template-columns: minmax(220px, 0.65fr) minmax(320px, 1fr);
  gap: 20px;
  padding: 16px 18px;
  background: var(--blue-soft);
  border-bottom: 1px solid var(--line);
}

.administrator-pending strong {
  color: var(--ink);
  font-size: 12px;
}

.administrator-pending p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 10px;
}

.administrator-pending ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.administrator-pending li {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  background: #fff;
  border: 1px solid rgb(47 83 120 / 12%);
  border-radius: var(--radius-xs);
}

.administrator-pending li span {
  overflow: hidden;
  color: var(--ink);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.administrator-pending li small {
  flex: 0 0 auto;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
}

.administrator-table {
  min-width: 980px;
}

.administrator-table th,
.administrator-table td {
  padding-inline: 16px;
}

.administrator-id {
  color: var(--blue);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.administrator-table .row-title small {
  margin-left: 5px;
  padding: 2px 5px;
  color: var(--blue);
  background: var(--blue-soft);
  border-radius: 3px;
  font-size: 9px;
}

.administrator-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.administrator-actions .button {
  min-height: 40px;
}

.administrator-protected {
  color: var(--muted);
  font-size: 10px;
}

:global(
  .admin-body:has(
    .account-create-dialog[open],
    .customer-detail-dialog[open],
    .customer-delete-dialog[open]
  )
) {
  overflow: hidden;
}

.account-create-dialog {
  position: fixed;
  inset: 0;
  z-index: 185;
  width: min(680px, calc(100vw - 32px));
  max-width: none;
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  overflow: auto;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: 0 24px 70px rgb(23 34 51 / 24%);
  overscroll-behavior: contain;
  animation: customer-dialog-enter 160ms ease-out;
}

.account-create-dialog > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line);
}

.account-create-dialog h2 {
  margin: 4px 0 0;
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 500;
}

.account-create-dialog > header p:not(.eyebrow) {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
}

.account-create-form {
  padding: 22px 24px 24px;
  background: var(--paper);
}

.account-create-form .form-grid {
  gap: 16px;
}

.account-create-form .form-field > small {
  display: block;
  margin-top: 7px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.6;
}

.administrator-credential-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  padding: 11px 13px;
  color: var(--muted);
  background: var(--blue-soft);
  border-radius: var(--radius-xs);
  font-size: 10px;
}

.administrator-credential-summary strong {
  color: var(--blue);
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
  text-align: right;
}

.administrator-credential-note {
  margin: 18px 0 0;
  padding-top: 14px;
  color: var(--muted);
  border-top: 1px solid var(--line);
  font-size: 10px;
  line-height: 1.7;
}

.account-create-dialog > .admin-error {
  margin: 0 24px 18px;
}

.account-create-dialog > footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 24px;
  background: #fff;
  border-top: 1px solid var(--line);
}

.administrator-invitation-link {
  display: grid;
  gap: 8px;
  margin-top: 18px;
  padding: 14px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.administrator-invitation-link > span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.administrator-invitation-link code {
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: 10px;
  line-height: 1.7;
}

.administrator-invitation-link .button {
  justify-self: start;
}

.customer-detail-dialog {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(1080px, calc(100vw - 40px));
  max-width: none;
  height: min(860px, calc(100dvh - 40px));
  max-height: none;
  margin: auto;
  padding: 0;
  overflow: hidden;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: 0 24px 70px rgb(23 34 51 / 24%);
  animation: customer-dialog-enter 160ms ease-out;
}

.account-create-dialog:not([open]),
.customer-detail-dialog:not([open]),
.customer-delete-dialog:not([open]) {
  display: none;
}

.account-create-dialog::backdrop,
.customer-detail-dialog::backdrop,
.customer-delete-dialog::backdrop {
  background: rgb(16 38 62 / 50%);
}

.customer-detail-dialog > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px;
  background: #fff;
  border-bottom: 1px solid var(--line);
}

.customer-detail-dialog h2,
.customer-delete-dialog h2 {
  margin: 4px 0 0;
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 500;
}

.customer-detail-dialog > header p:not(.eyebrow) {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
}

.customer-detail-close {
  min-width: 64px;
  height: 40px;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  font-size: 11px;
  font-weight: 600;
}

.customer-detail-close span {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 400;
}

.customer-detail-close:hover {
  color: var(--blue);
  background: var(--blue-soft);
  border-color: var(--line);
}

.customer-dialog-loading,
.customer-dialog-error {
  display: grid;
  min-height: 260px;
  place-items: center;
  padding: 24px;
  background: var(--paper);
}

.customer-dialog-error .admin-error {
  width: min(520px, 100%);
}

.customer-detail-scroll {
  overflow-y: auto;
  padding: 20px 24px 24px;
  background: var(--paper);
  overscroll-behavior: contain;
}

.customer-detail-scroll > .admin-success,
.customer-detail-scroll > .admin-error {
  margin-top: 0;
}

.customer-account-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 16px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.customer-account-summary > div {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 5px;
  min-height: 96px;
  padding: 14px 18px;
}

.customer-account-summary > div + div {
  border-left: 1px solid var(--line);
}

.customer-account-summary span,
.customer-account-summary small {
  color: var(--muted);
  font-size: 10px;
}

.customer-account-summary span {
  font-family: var(--mono);
  font-weight: 700;
  letter-spacing: 0.05em;
}

.customer-account-summary strong {
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.customer-detail-section {
  padding: 20px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.admin-showcase-list {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.admin-showcase-list > article {
  padding: 18px;
  border: 1px solid var(--admin-line, #dfe4eb);
  border-radius: 10px;
  background: #fbfcfe;
}

.admin-showcase-list article > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.admin-showcase-list header span:first-child {
  color: #5f6f87;
  font: 700 10px var(--admin-mono, monospace);
}

.admin-showcase-list h4 {
  margin: 5px 0 4px;
  font-size: 15px;
}

.admin-showcase-list header p,
.admin-showcase-intro {
  margin: 0;
  color: #677286;
  font-size: 12px;
  line-height: 1.65;
}

.admin-showcase-list dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 16px 0;
  border-block: 1px solid #e7ebf1;
}

.admin-showcase-list dl > div {
  padding: 12px 8px 12px 0;
}

.admin-showcase-list dt {
  color: #8a94a5;
  font-size: 10px;
}

.admin-showcase-list dd {
  margin: 5px 0 0;
  color: #2a3446;
  font-size: 12px;
}

.admin-showcase-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.admin-showcase-fields span {
  padding: 4px 7px;
  border-radius: 5px;
  background: #eceff4;
  color: #788396;
  font-size: 10px;
}

.admin-showcase-fields span.enabled {
  background: #e9f6ef;
  color: #18704a;
}

.admin-showcase-intro {
  margin-top: 14px;
  white-space: pre-wrap;
}

.admin-showcase-links {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.admin-showcase-links a {
  color: #215ecf;
  font-size: 11px;
  font-weight: 700;
}

.admin-showcase-links code {
  overflow: hidden;
  color: #7d8798;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-showcase-moderation {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid #e7ebf1;
}

.admin-showcase-moderation input {
  min-height: 36px;
  flex: 1;
  border: 1px solid #d7dde7;
  border-radius: 6px;
  padding: 0 10px;
}

.admin-showcase-moderation p {
  flex: 1;
  margin: 0;
  color: #9b4b25;
  font-size: 11px;
}

.customer-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.customer-section-heading h3 {
  margin: 4px 0 0;
  color: var(--ink);
  font-size: 16px;
  font-weight: 650;
}

.customer-record-count {
  padding-top: 4px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
}

.customer-detail-form .form-grid {
  gap: 16px;
}

.customer-detail-form .form-field label {
  margin-bottom: 7px;
}

.customer-readonly-profile {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
}

.customer-readonly-profile > div {
  min-width: 0;
  padding: 13px 15px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.customer-readonly-profile dt {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
}

.customer-readonly-profile dd {
  overflow: hidden;
  margin: 6px 0 0;
  color: var(--ink);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.customer-history-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 16px;
}

.customer-history-list {
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
  list-style: none;
}

.customer-history-list li {
  display: flex;
  min-height: 66px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--line);
}

.customer-history-list li > span {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.customer-history-list li > span:last-child {
  flex: 0 0 auto;
  justify-items: end;
}

.customer-history-list strong,
.customer-history-list b {
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.customer-history-list small {
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.customer-history-list .admin-empty {
  display: block;
  min-height: 0;
  padding: 18px 0;
}

.history-more {
  width: 100%;
  margin-top: 12px;
}

.customer-detail-actions {
  display: flex;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 24px;
  background: #fff;
  border-top: 1px solid var(--line);
}

.customer-detail-actions p {
  margin: 0;
  color: var(--muted);
  font-size: 10px;
}

.customer-detail-actions > div {
  display: flex;
  gap: 10px;
}

.customer-delete-dialog {
  position: fixed;
  inset: 0;
  z-index: 190;
  width: min(480px, calc(100vw - 32px));
  max-width: none;
  margin: auto;
  padding: 28px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: 0 24px 70px rgb(23 34 51 / 24%);
  animation: customer-dialog-enter 160ms ease-out;
}

.customer-delete-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  margin-bottom: 18px;
  color: var(--red);
  background: rgb(164 54 45 / 8%);
  border: 1px solid rgb(164 54 45 / 24%);
  border-radius: 50%;
  font-family: var(--serif);
  font-size: 22px;
}

.customer-delete-dialog h2 {
  font-size: 26px;
}

.customer-delete-target {
  display: grid;
  gap: 4px;
  margin-top: 20px;
  padding: 13px 15px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.customer-delete-target strong {
  font-size: 13px;
}

.customer-delete-target span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
}

.customer-delete-dialog > p:not(.eyebrow):not(.admin-error) {
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.75;
}

.customer-delete-dialog > .admin-error {
  margin: 14px 0 0;
}

.customer-delete-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

@keyframes customer-dialog-enter {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.992);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (max-width: 900px) {
  .administrator-pending {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .customer-list-tools {
    width: 100%;
    flex-wrap: wrap;
  }

  .customer-filters {
    width: 100%;
    flex-wrap: wrap;
  }

  .customer-filters input {
    flex: 1 1 180px;
  }

  .customer-account-summary {
    grid-template-columns: 1fr 1fr;
  }

  .customer-account-summary > div:nth-child(3) {
    border-left: 0;
  }

  .customer-account-summary > div:nth-child(n + 3) {
    border-top: 1px solid var(--line);
  }

  .customer-history-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 700px) {
  .directory-page-actions {
    justify-content: flex-start;
  }

  .directory-page-actions .status-badge {
    width: 100%;
    justify-content: center;
  }

  .directory-tabs,
  .directory-tab {
    width: 100%;
  }

  .directory-tab {
    justify-content: center;
  }

  .administrator-list-panel .admin-panel-header {
    align-items: stretch;
    flex-direction: column;
  }

  .administrator-pending li {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }

  .administrator-table {
    min-width: 0;
    border-collapse: separate;
    border-spacing: 0;
  }

  .administrator-table thead {
    display: none;
  }

  .administrator-table tbody {
    display: grid;
    gap: 12px;
    padding: 12px;
  }

  .administrator-table tr {
    display: grid;
    overflow: hidden;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .administrator-table td {
    display: grid;
    min-height: 0;
    grid-template-columns: 88px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
  }

  .administrator-table td::before {
    color: var(--muted);
    content: attr(data-label);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
  }

  .administrator-table td:last-child {
    border-bottom: 0;
  }

  .administrator-table .admin-empty {
    display: block;
  }

  .administrator-table .admin-empty::before {
    content: none;
  }

  .account-create-dialog {
    width: calc(100vw - 24px);
  }

  .account-create-dialog > header,
  .account-create-form,
  .account-create-dialog > footer {
    padding-inline: 16px;
  }

  .account-create-form .form-grid {
    grid-template-columns: 1fr;
  }

  .customer-list-panel .admin-panel-header {
    align-items: stretch;
    flex-direction: column;
  }

  .customer-filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .customer-list-tools {
    align-items: stretch;
    flex-direction: column;
  }

  .customer-export-button {
    width: 100%;
  }

  .customer-export-confirm {
    align-items: stretch;
    flex-direction: column;
  }

  .customer-export-confirm > div:last-child {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .customer-pagination {
    align-items: stretch;
    flex-direction: column;
  }

  .customer-pagination nav {
    flex-wrap: wrap;
    justify-content: center;
  }

  .customer-filters input {
    grid-column: 1 / -1;
    width: 100%;
  }

  .customer-filters select {
    width: 100%;
  }

  .customer-table {
    min-width: 0;
    border-collapse: separate;
    border-spacing: 0;
  }

  .customer-table thead {
    display: none;
  }

  .customer-table tbody {
    display: grid;
    gap: 12px;
    padding: 12px;
  }

  .customer-table tr {
    display: grid;
    overflow: visible;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
  }

  .customer-table td {
    display: grid;
    min-height: 0;
    grid-template-columns: 76px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
    text-align: left;
  }

  .customer-table td::before {
    color: var(--muted);
    content: attr(data-label);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .customer-table td:last-child {
    border-bottom: 0;
  }

  .customer-id-cell {
    width: auto;
  }

  .customer-copy-value {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }

  .customer-row-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .customer-actions-column {
    position: static;
    width: auto;
    min-width: 0;
    box-shadow: none;
  }

  .customer-more,
  .customer-more > .button {
    width: 100%;
  }

  .customer-more-menu {
    width: 180px;
  }

  .customer-sourced-value {
    flex-wrap: wrap;
  }

  .customer-table .customer-row-actions .button {
    width: 100%;
  }

  .customer-registration-column,
  .customer-registration-column .row-sub {
    text-align: left;
  }

  .customer-table .admin-empty {
    display: block;
    grid-column: 1 / -1;
  }

  .customer-table .admin-empty::before {
    content: none;
  }

  .customer-detail-dialog {
    width: calc(100vw - 24px);
    height: calc(100dvh - 24px);
  }

  .customer-detail-dialog > header,
  .customer-detail-scroll,
  .customer-detail-actions {
    padding-inline: 16px;
  }

  .customer-detail-form .form-grid,
  .customer-readonly-profile {
    grid-template-columns: 1fr;
  }

  .customer-detail-actions {
    align-items: stretch;
    flex-direction: column;
    gap: 9px;
  }

  .customer-detail-actions > div {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .customer-detail-actions .button {
    width: 100%;
  }
}

@media (max-width: 520px) {
  .directory-page-actions .button {
    flex: 1 1 0;
  }

  .account-create-dialog {
    width: 100vw;
    max-height: 100dvh;
    border: 0;
    border-radius: 0;
  }

  .account-create-dialog > footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .account-create-dialog > footer .button {
    width: 100%;
  }

  .customer-detail-dialog {
    width: 100vw;
    height: 100dvh;
    border: 0;
    border-radius: 0;
  }

  .customer-detail-dialog > header {
    padding-block: 16px;
  }

  .customer-detail-dialog h2 {
    font-size: 21px;
  }

  .customer-detail-dialog > header p:not(.eyebrow) {
    max-width: 220px;
  }

  .customer-detail-scroll {
    padding-block: 14px;
  }

  .customer-account-summary {
    grid-template-columns: 1fr;
  }

  .customer-account-summary > div + div,
  .customer-account-summary > div:nth-child(3) {
    border-top: 1px solid var(--line);
    border-left: 0;
  }

  .customer-detail-section {
    padding: 16px;
  }

  .customer-history-list li {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding: 13px 0;
  }

  .customer-history-list li > span:last-child {
    width: 100%;
    display: flex;
    justify-content: space-between;
  }

  .customer-delete-dialog {
    width: calc(100vw - 24px);
    padding: 22px;
  }

  .customer-delete-dialog footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .customer-delete-dialog footer .button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .account-create-dialog,
  .customer-detail-dialog,
  .customer-delete-dialog {
    animation: none;
  }
}
</style>
