<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import {
  type InvoiceListQuery,
  type InvoiceRequest,
  type InvoiceRequestStatus,
} from '@conference/contracts';
import { useRoute, useRouter } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import { dateTime } from '../lib/format';
import { parseEventId } from '../lib/route-scope';

const PAGE_SIZE = 20;

const route = useRoute();
const router = useRouter();
const rows = ref<InvoiceRequest[]>([]);
const nextCursor = ref<string | null>(null);
const currentPage = ref(1);
const pageCursors = ref<Array<string | undefined>>([undefined]);
const detail = ref<InvoiceRequest>();
const detailDialog = ref<HTMLDialogElement>();
const detailTrigger = ref<HTMLButtonElement>();
const loading = ref(true);
const detailLoading = ref(false);
const pending = ref(false);
const errorMessage = ref('');
const message = ref('');
const query = ref(String(route.query.q ?? ''));
const status = ref(String(route.query.status ?? ''));
const eventId = computed(() => {
  const value = Array.isArray(route.params.eventId)
    ? route.params.eventId[0]
    : route.params.eventId;
  return parseEventId(value);
});
const fromDate = ref(String(route.query.fromDate ?? ''));
const toDate = ref(String(route.query.toDate ?? ''));
const dateField = ref<'requested' | 'issued'>(
  route.query.dateField === 'issued' ? 'issued' : 'requested',
);
const actionMode = ref<'' | 'reject' | 'retry' | 'issue-failed' | 'cancel' | 'document' | 'void'>(
  '',
);
const actionReason = ref('');
const voidDocumentId = ref('');
const exportConfirmation = ref(false);
const exporting = ref(false);
const selectedDocumentFile = ref<File>();
const canManage = computed(() => session.can('org.invoice.manage'));
const canExport = computed(() => session.can('org.invoice.export'));
const selectedId = computed(() => String(route.params.invoiceId ?? ''));
const visibleRange = computed(() => {
  if (!rows.value.length) return '0 条发票申请';
  const start = (currentPage.value - 1) * PAGE_SIZE + 1;
  const end = start + rows.value.length - 1;
  return `第 ${start}–${end} 条 · 每页 ${PAGE_SIZE} 条`;
});
const activeDocument = computed(() =>
  detail.value?.documents.find((document) => !document.voidedAt),
);
const documentForm = reactive({
  documentType: 'original' as 'original' | 'adjustment' | 'reissue',
  invoiceNumber: '',
  invoiceCode: '',
  externalReference: '',
  storageKey: '',
  mediaType: 'application/pdf' as 'application/pdf' | 'application/ofd',
  size: 0,
  contentDigest: '',
  fileName: '',
});
let loadSequence = 0;

const statusLabels: Record<InvoiceRequestStatus, string> = {
  awaiting_details: '待补充资料',
  pending_review: '待审核',
  issuing: '开具中',
  issue_failed: '开具失败',
  issued: '已开具',
  rejected: '已驳回',
  adjustment_required: '退款待调整',
  voided: '已作废',
  cancelled: '已取消',
};
const buyerTypeLabels = {
  individual: '个人',
  company: '企业',
} as const;
const deliveryStatusLabels = {
  not_sent: '尚未发送',
  queued: '等待发送',
  sent: '已发送给用户',
  failed: '发送失败',
} as const;
const documentTypeLabels = {
  original: '原始发票',
  adjustment: '调整文件',
  reissue: '重开发票',
} as const;

function statusTone(value: InvoiceRequestStatus) {
  if (value === 'issued') return 'success';
  if (['pending_review', 'issuing', 'awaiting_details'].includes(value)) return 'pending';
  if (['rejected', 'issue_failed', 'adjustment_required'].includes(value)) return 'failed';
  return 'neutral';
}

function money(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
  }).format(value / 100);
}

function currentFilters(): InvoiceListQuery {
  return {
    ...(query.value.trim() ? { q: query.value.trim() } : {}),
    ...(status.value ? { status: status.value as InvoiceRequestStatus } : {}),
    ...(fromDate.value ? { from: new Date(`${fromDate.value}T00:00:00+08:00`).toISOString() } : {}),
    ...(toDate.value ? { to: new Date(`${toDate.value}T23:59:59.999+08:00`).toISOString() } : {}),
    dateField: dateField.value,
  };
}

function routeFilters() {
  return {
    ...(query.value ? { q: query.value } : {}),
    ...(status.value ? { status: status.value } : {}),
    ...(fromDate.value ? { fromDate: fromDate.value } : {}),
    ...(toDate.value ? { toDate: toDate.value } : {}),
    ...(dateField.value === 'issued' ? { dateField: 'issued' } : {}),
  };
}

async function load(targetPage = currentPage.value) {
  const normalizedPage = Math.max(1, Math.round(targetPage) || 1);
  const cursor = pageCursors.value[normalizedPage - 1];
  if (normalizedPage > 1 && !cursor) return;
  const sequence = ++loadSequence;
  loading.value = true;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.getInvoices(
      {
        ...currentFilters(),
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
      },
      eventId.value,
    );
    if (sequence !== loadSequence) return;
    rows.value = result.items;
    currentPage.value = normalizedPage;
    nextCursor.value = result.nextCursor;
    const nextPageCursors = pageCursors.value.slice(0, normalizedPage);
    if (result.nextCursor) nextPageCursors[normalizedPage] = result.nextCursor;
    pageCursors.value = nextPageCursors;
  } catch (error) {
    if (sequence !== loadSequence) return;
    errorMessage.value = error instanceof Error ? error.message : '发票申请读取失败';
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function resetPagination() {
  currentPage.value = 1;
  pageCursors.value = [undefined];
  nextCursor.value = null;
}

function changePage(targetPage: number) {
  if (loading.value || targetPage < 1 || targetPage === currentPage.value) return;
  if (targetPage > currentPage.value && !nextCursor.value) return;
  void load(targetPage);
}

async function loadDetail() {
  if (!selectedId.value) {
    detail.value = undefined;
    return;
  }
  detailLoading.value = true;
  errorMessage.value = '';
  try {
    detail.value = await conferenceApi.getInvoice(selectedId.value, eventId.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票详情读取失败';
  } finally {
    detailLoading.value = false;
  }
}

function selectInvoice(item: InvoiceRequest, event: MouseEvent) {
  actionMode.value = '';
  detailTrigger.value = event.currentTarget as HTMLButtonElement;
  void router.push({
    name: 'event-invoices',
    params: { eventId: eventId.value, invoiceId: item.id },
    query: routeFilters(),
  });
}

async function closeDetail() {
  const trigger = detailTrigger.value;
  await router.push({
    name: 'event-invoices',
    params: { eventId: eventId.value },
    query: routeFilters(),
  });
  await nextTick();
  trigger?.focus();
}

function closeDetailFromBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) void closeDetail();
}

function openDocumentForm() {
  if (detail.value?.documents.length) documentForm.documentType = 'reissue';
  actionMode.value = 'document';
}

async function refreshAfterAction(updated?: InvoiceRequest) {
  if (updated) detail.value = updated;
  actionMode.value = '';
  actionReason.value = '';
  await load();
  if (!rows.value.length && currentPage.value > 1) await load(currentPage.value - 1);
}

async function approve() {
  if (!detail.value) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.approveInvoice(
      detail.value.id,
      detail.value.updatedAt,
      eventId.value,
    );
    message.value = `${updated.requestNo} 已审核通过，进入开具中。`;
    await refreshAfterAction(updated);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '审核操作失败';
  } finally {
    pending.value = false;
  }
}

async function submitAction() {
  if (
    !detail.value ||
    !actionMode.value ||
    actionMode.value === 'document' ||
    actionMode.value === 'void'
  )
    return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.invoiceAction(
      detail.value.id,
      actionMode.value,
      {
        reason: actionReason.value.trim(),
        expectedUpdatedAt: detail.value.updatedAt,
      },
      eventId.value,
    );
    message.value = `${updated.requestNo} 状态已更新为“${statusLabels[updated.status]}”。`;
    await refreshAfterAction(updated);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票状态更新失败';
  } finally {
    pending.value = false;
  }
}

async function chooseDocument(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const lowerName = file.name.toLocaleLowerCase();
  if (!lowerName.endsWith('.pdf') && !lowerName.endsWith('.ofd')) {
    errorMessage.value = '发票文件只支持 PDF 或 OFD。';
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    errorMessage.value = '发票文件不能超过 20 MB。';
    return;
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  documentForm.fileName = file.name;
  documentForm.size = file.size;
  documentForm.mediaType = lowerName.endsWith('.ofd') ? 'application/ofd' : 'application/pdf';
  documentForm.contentDigest = [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('');
  selectedDocumentFile.value = file;
}

async function submitDocument() {
  if (!detail.value || !selectedDocumentFile.value) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const upload = await conferenceApi.prepareInvoiceDocumentUpload(
      detail.value.id,
      {
        fileName: documentForm.fileName,
        mediaType: documentForm.mediaType,
        size: documentForm.size,
        contentDigest: documentForm.contentDigest,
      },
      eventId.value,
    );
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: upload.method,
      headers: upload.headers,
      body: selectedDocumentFile.value,
    });
    if (!uploadResponse.ok) {
      throw new Error(`电子发票文件上传失败（${uploadResponse.status}）`);
    }
    documentForm.storageKey = upload.storageKey;
    const updated = await conferenceApi.addInvoiceDocument(
      detail.value.id,
      {
        documentType: documentForm.documentType,
        invoiceNumber: documentForm.invoiceNumber.trim(),
        ...(documentForm.invoiceCode.trim()
          ? { invoiceCode: documentForm.invoiceCode.trim() }
          : {}),
        ...(documentForm.externalReference.trim()
          ? { externalReference: documentForm.externalReference.trim() }
          : {}),
        storageKey: documentForm.storageKey,
        mediaType: documentForm.mediaType,
        size: documentForm.size,
        contentDigest: documentForm.contentDigest,
        ...(documentForm.documentType !== 'original' && detail.value.documents[0]
          ? { replacesDocumentId: detail.value.documents[0].id }
          : {}),
      },
      eventId.value,
    );
    message.value = `${documentForm.invoiceNumber} 已登记，申请状态已更新为已开具。`;
    Object.assign(documentForm, {
      documentType: 'original',
      invoiceNumber: '',
      invoiceCode: '',
      externalReference: '',
      storageKey: '',
      mediaType: 'application/pdf',
      size: 0,
      contentDigest: '',
      fileName: '',
    });
    selectedDocumentFile.value = undefined;
    await refreshAfterAction(updated);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票文件登记失败';
  } finally {
    pending.value = false;
  }
}

async function voidDocument() {
  if (!detail.value || !voidDocumentId.value) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.voidInvoiceDocument(
      detail.value.id,
      voidDocumentId.value,
      actionReason.value.trim(),
      detail.value.updatedAt,
      eventId.value,
    );
    message.value = '指定发票文件已作废，历史记录继续保留。';
    voidDocumentId.value = '';
    await refreshAfterAction(updated);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '作废操作失败';
  } finally {
    pending.value = false;
  }
}

async function sendInvoice() {
  if (!detail.value) return;
  pending.value = true;
  try {
    await conferenceApi.sendInvoice(detail.value.id, eventId.value);
    message.value = `发票已加入发送队列，将发送至 ${detail.value.maskedEmail ?? '接收邮箱'}。`;
    await loadDetail();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票发送失败';
  } finally {
    pending.value = false;
  }
}

async function downloadDocument(documentId: string, invoiceNumber: string, mediaType: string) {
  if (!detail.value) return;
  errorMessage.value = '';
  try {
    await conferenceApi.downloadInvoiceDocument(
      detail.value.id,
      documentId,
      `${invoiceNumber}.${mediaType === 'application/ofd' ? 'ofd' : 'pdf'}`,
      eventId.value,
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '电子发票下载失败';
  }
}

async function exportRows() {
  exporting.value = true;
  errorMessage.value = '';
  try {
    const count = await conferenceApi.exportInvoices(currentFilters(), eventId.value);
    exportConfirmation.value = false;
    message.value = `已按当前筛选导出 ${count} 条发票申请。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发票申请导出失败';
  } finally {
    exporting.value = false;
  }
}

watch([query, status, fromDate, toDate, dateField], (_values, _oldValues, onCleanup) => {
  const timer = window.setTimeout(
    () => {
      resetPagination();
      void load(1);
    },
    query.value ? 300 : 0,
  );
  onCleanup(() => window.clearTimeout(timer));
});
watch(eventId, (nextEventId, previousEventId) => {
  if (!nextEventId || nextEventId === previousEventId) return;
  rows.value = [];
  resetPagination();
  detail.value = undefined;
  void load(1);
});
watch(
  selectedId,
  async (invoiceId) => {
    await loadDetail();
    if (!invoiceId) return;
    await nextTick();
    if (detailDialog.value && !detailDialog.value.open) detailDialog.value.showModal();
  },
  { immediate: true },
);
onMounted(() => {
  void load(1);
});
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">FINANCE OPERATIONS</p>
      <h1>发票管理</h1>
      <p>处理当前大会的发票资料、审核、开具、发送、退款调整与作废记录。</p>
    </div>
  </header>
  <p v-if="message" class="admin-success" role="status">{{ message }}</p>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <section class="admin-panel invoice-list-panel">
    <header class="admin-panel-header">
      <div>
        <h2>发票申请</h2>
        <p>{{ visibleRange }}</p>
      </div>
    </header>
    <form class="admin-filter-bar invoice-filter-bar" role="search" @submit.prevent>
      <label class="admin-search">
        <span aria-hidden="true">⌕</span>
        <input
          v-model="query"
          type="search"
          aria-label="搜索发票"
          placeholder="搜索申请单、订单、抬头或税号"
        />
      </label>
      <label class="admin-select-label invoice-compact-filter">
        <span class="sr-only">状态</span>
        <select v-model="status" class="admin-select" aria-label="状态">
          <option value="">全部状态</option>
          <option v-for="(label, key) in statusLabels" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <label class="admin-select-label invoice-compact-filter">
        <span class="sr-only">日期口径</span>
        <select v-model="dateField" class="admin-select" aria-label="日期口径">
          <option value="requested">申请时间</option>
          <option value="issued">开票时间</option>
        </select>
      </label>
      <div class="admin-select-label invoice-date-range">
        <span class="sr-only">日期范围</span>
        <div class="invoice-date-range__controls">
          <label>
            <span class="sr-only">开始日期</span>
            <input v-model="fromDate" class="admin-select" type="date" aria-label="开始日期" />
          </label>
          <span aria-hidden="true">至</span>
          <label>
            <span class="sr-only">结束日期</span>
            <input v-model="toDate" class="admin-select" type="date" aria-label="结束日期" />
          </label>
        </div>
      </div>
      <button
        v-if="canExport"
        class="button secondary invoice-export-button"
        type="button"
        @click="exportConfirmation = true"
      >
        导出当前结果
      </button>
    </form>
    <div v-if="loading" class="admin-loading">正在读取发票申请…</div>
    <div v-else-if="rows.length" class="invoice-table-wrap">
      <table class="data-table invoice-table">
        <thead>
          <tr>
            <th>申请单 / 订单</th>
            <th>申请人</th>
            <th>发票抬头</th>
            <th>金额</th>
            <th>状态</th>
            <th>申请时间</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rows" :key="item.id" :class="{ selected: selectedId === item.id }">
            <td data-label="申请单 / 订单">
              <strong>{{ item.requestNo }}</strong><small>{{ item.orderNo }}</small>
            </td>
            <td data-label="申请人">
              <strong>{{ item.attendeeName }}</strong>
              <small>{{ item.maskedMobile ?? '手机号待补充' }}</small>
            </td>
            <td data-label="发票抬头">
              <span>{{ item.title ?? '资料待补充' }}</span><small>{{ item.maskedTaxId }}</small>
            </td>
            <td data-label="金额">{{ money(item.amount) }}</td>
            <td data-label="状态">
              <span class="invoice-status" :class="statusTone(item.status)">
                <i aria-hidden="true"></i>{{ statusLabels[item.status] }}
              </span>
            </td>
            <td data-label="申请时间">{{ dateTime(item.requestedAt) }}</td>
            <td class="invoice-row-action">
              <button
                class="button secondary compact"
                type="button"
                @click="selectInvoice(item, $event)"
              >
                查看详情
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="admin-empty">当前筛选下没有发票申请。</div>
    <footer v-if="rows.length || currentPage > 1" class="table-footer invoice-pagination">
      <span>{{ visibleRange }}</span>
      <nav class="mini-pagination" aria-label="发票申请分页">
        <button
          type="button"
          aria-label="上一页"
          :disabled="currentPage === 1 || loading"
          @click="changePage(currentPage - 1)"
        >
          ‹
        </button>
        <button
          class="active"
          type="button"
          :aria-label="`第 ${currentPage} 页`"
          aria-current="page"
          disabled
        >
          {{ currentPage }}
        </button>
        <button
          type="button"
          aria-label="下一页"
          :disabled="!nextCursor || loading"
          @click="changePage(currentPage + 1)"
        >
          ›
        </button>
      </nav>
    </footer>
  </section>

  <dialog
    v-if="selectedId"
    ref="detailDialog"
    class="invoice-detail-panel"
    aria-labelledby="invoice-detail-title"
    aria-describedby="invoice-detail-description"
    @cancel.prevent="closeDetail"
    @click="closeDetailFromBackdrop"
  >
    <header>
      <div>
        <p class="eyebrow">INVOICE DETAIL</p>
        <h2 id="invoice-detail-title">{{ detail?.requestNo ?? '正在载入…' }}</h2>
        <p id="invoice-detail-description">
          {{
            detail
              ? `${detail.attendeeName} · ${detail.eventName} · 订单 ${detail.orderNo}`
              : '正在读取发票申请的完整信息'
          }}
        </p>
      </div>
      <button
        class="invoice-detail-close"
        type="button"
        aria-label="关闭发票详情"
        title="关闭"
        @click="closeDetail"
      >
        <span aria-hidden="true">×</span>关闭
      </button>
    </header>
    <div v-if="detailLoading" class="admin-loading">正在读取发票详情…</div>
    <template v-else-if="detail">
      <div class="invoice-detail-scroll">
        <div class="invoice-detail-summary">
          <div>
            <span>当前状态</span>
            <strong class="invoice-status" :class="statusTone(detail.status)">
              <i aria-hidden="true"></i>{{ statusLabels[detail.status] }}
            </strong>
          </div>
          <div>
            <span>开票金额</span>
            <strong>{{ money(detail.amount) }}</strong>
            <small>订单实付 {{ money(detail.netPaidAmount) }}</small>
          </div>
          <div>
            <span>用户通知</span>
            <strong>{{ deliveryStatusLabels[detail.deliveryStatus] }}</strong>
            <small>
              {{ detail.lastSentAt ? `最近发送 ${dateTime(detail.lastSentAt)}` : '尚无发送时间' }}
            </small>
          </div>
        </div>

        <div class="invoice-detail-layout">
          <section class="invoice-detail-section">
            <header>
              <div>
                <p class="eyebrow">APPLICANT</p>
                <h3>申请人与大会</h3>
              </div>
              <span>{{ dateTime(detail.requestedAt) }}</span>
            </header>
            <dl class="invoice-detail-grid-list">
              <div>
                <dt>申请人</dt>
                <dd>{{ detail.attendeeName }}</dd>
              </div>
              <div>
                <dt>用户手机号</dt>
                <dd>{{ detail.mobile ?? detail.maskedMobile ?? '待补充' }}</dd>
              </div>
              <div>
                <dt>接收邮箱</dt>
                <dd>{{ detail.email ?? detail.maskedEmail ?? '待补充' }}</dd>
              </div>
              <div>
                <dt>报名大会</dt>
                <dd>{{ detail.eventName }}</dd>
              </div>
              <div>
                <dt>订单号</dt>
                <dd>{{ detail.orderNo }}</dd>
              </div>
              <div>
                <dt>申请时间</dt>
                <dd>{{ dateTime(detail.requestedAt) }}</dd>
              </div>
            </dl>
          </section>

          <section class="invoice-detail-section">
            <header>
              <div>
                <p class="eyebrow">BILLING PROFILE</p>
                <h3>开票资料</h3>
              </div>
              <span>{{ detail.title ?? '资料待补充' }}</span>
            </header>
            <dl class="invoice-detail-grid-list">
              <div>
                <dt>购买方类型</dt>
                <dd>{{ detail.buyerType ? buyerTypeLabels[detail.buyerType] : '待补充' }}</dd>
              </div>
              <div>
                <dt>发票抬头</dt>
                <dd>{{ detail.title ?? '待补充' }}</dd>
              </div>
              <div>
                <dt>统一社会信用代码</dt>
                <dd>{{ detail.taxId ?? detail.maskedTaxId ?? '不适用' }}</dd>
              </div>
              <div>
                <dt>开票内容</dt>
                <dd>{{ detail.content ?? '待补充' }}</dd>
              </div>
              <div>
                <dt>发票金额</dt>
                <dd>{{ money(detail.amount) }}</dd>
              </div>
              <div>
                <dt>订单实付</dt>
                <dd>{{ money(detail.netPaidAmount) }}</dd>
              </div>
              <div>
                <dt>审核时间</dt>
                <dd>{{ detail.reviewedAt ? dateTime(detail.reviewedAt) : '尚未审核' }}</dd>
              </div>
              <div>
                <dt>开票时间</dt>
                <dd>{{ activeDocument ? dateTime(activeDocument.issuedAt) : '尚未开票' }}</dd>
              </div>
              <div v-if="detail.rejectionReason" class="invoice-detail-grid-list__wide">
                <dt>驳回或失败原因</dt>
                <dd>{{ detail.rejectionReason }}</dd>
              </div>
            </dl>
          </section>

          <section class="invoice-detail-section invoice-detail-section--wide invoice-documents">
            <header>
              <div>
                <p class="eyebrow">DOCUMENTS</p>
                <h3>电子发票与下载</h3>
              </div>
              <span>{{ detail.documents.length }} 份文件</span>
            </header>
            <article v-for="document in detail.documents" :key="document.id">
              <div class="invoice-document-heading">
                <div>
                  <strong>{{ document.invoiceNumber }}</strong>
                  <small>{{ documentTypeLabels[document.documentType] }}</small>
                </div>
                <span v-if="document.voidedAt" class="status-badge neutral">已作废</span>
                <span v-else class="status-badge success">可下载</span>
              </div>
              <dl class="invoice-document-meta">
                <div>
                  <dt>发票代码</dt>
                  <dd>{{ document.invoiceCode ?? '未填写' }}</dd>
                </div>
                <div>
                  <dt>开票时间</dt>
                  <dd>{{ dateTime(document.issuedAt) }}</dd>
                </div>
                <div>
                  <dt>文件</dt>
                  <dd>
                    {{ document.mediaType === 'application/ofd' ? 'OFD' : 'PDF' }} ·
                    {{ Math.ceil(document.size / 1024) }} KB
                  </dd>
                </div>
                <div v-if="document.externalReference">
                  <dt>外部流水号</dt>
                  <dd>{{ document.externalReference }}</dd>
                </div>
                <div v-if="document.voidedAt">
                  <dt>作废时间</dt>
                  <dd>{{ dateTime(document.voidedAt) }}</dd>
                </div>
                <div v-if="document.voidReason">
                  <dt>作废原因</dt>
                  <dd>{{ document.voidReason }}</dd>
                </div>
              </dl>
              <div class="invoice-document-actions">
                <button
                  v-if="!document.voidedAt"
                  class="button secondary compact"
                  type="button"
                  @click="downloadDocument(document.id, document.invoiceNumber, document.mediaType)"
                >
                  下载发票
                </button>
                <button
                  v-if="
                    !document.voidedAt &&
                      canManage &&
                      ['issued', 'adjustment_required'].includes(detail.status)
                  "
                  class="button danger compact"
                  type="button"
                  @click="
                    voidDocumentId = document.id;
                    actionMode = 'void';
                  "
                >
                  作废文件
                </button>
              </div>
            </article>
            <p v-if="!detail.documents.length" class="invoice-detail-empty">
              尚未登记电子发票文件，开票完成后可在此下载。
            </p>
          </section>

          <section class="invoice-detail-section invoice-detail-section--wide invoice-timeline">
            <header>
              <div>
                <p class="eyebrow">HISTORY</p>
                <h3>完整处理记录</h3>
              </div>
              <span>更新于 {{ dateTime(detail.updatedAt) }}</span>
            </header>
            <ol>
              <li v-for="log in detail.logs" :key="log.id">
                <i aria-hidden="true"></i>
                <div>
                  <strong>{{ statusLabels[log.toStatus] }}</strong>
                  <p>{{ log.reason }}</p>
                  <small>{{ log.actorName ?? '参会人 / 系统' }} · {{ dateTime(log.createdAt) }}</small>
                </div>
              </li>
            </ol>
          </section>
        </div>
      </div>

      <div v-if="canManage" class="invoice-action-zone">
        <template v-if="!actionMode">
          <button
            v-if="detail.status === 'pending_review'"
            class="button"
            type="button"
            :disabled="pending"
            @click="approve"
          >
            审核通过
          </button>
          <button
            v-if="detail.status === 'pending_review'"
            class="button secondary danger"
            type="button"
            @click="actionMode = 'reject'"
          >
            驳回资料
          </button>
          <button
            v-if="['issuing'].includes(detail.status)"
            class="button"
            type="button"
            @click="openDocumentForm"
          >
            登记开票结果
          </button>
          <button
            v-if="detail.status === 'issuing'"
            class="button secondary danger"
            type="button"
            @click="actionMode = 'issue-failed'"
          >
            标记开具失败
          </button>
          <button
            v-if="['issue_failed', 'voided'].includes(detail.status)"
            class="button"
            type="button"
            @click="actionMode = 'retry'"
          >
            重新开具
          </button>
          <button
            v-if="detail.status === 'issued'"
            class="button secondary"
            type="button"
            :disabled="pending"
            @click="sendInvoice"
          >
            重新发送
          </button>
          <button
            v-if="
              ['awaiting_details', 'pending_review', 'rejected', 'issue_failed'].includes(
                detail.status,
              )
            "
            class="button secondary danger"
            type="button"
            @click="actionMode = 'cancel'"
          >
            取消申请
          </button>
        </template>

        <form
          v-else-if="actionMode === 'document'"
          class="invoice-action-form"
          @submit.prevent="submitDocument"
        >
          <h3>登记电子发票</h3>
          <div class="form-field">
            <label for="invoice-document-type">文件关系</label>
            <select id="invoice-document-type" v-model="documentForm.documentType">
              <option value="original">原始发票</option>
              <option value="adjustment">调整文件</option>
              <option value="reissue">重开发票</option>
            </select>
          </div>
          <div class="form-field">
            <label for="invoice-number">发票号码</label>
            <input id="invoice-number" v-model="documentForm.invoiceNumber" required />
          </div>
          <div class="form-field">
            <label for="invoice-file">电子发票文件</label>
            <input
              id="invoice-file"
              type="file"
              accept=".pdf,.ofd"
              required
              @change="chooseDocument"
            />
            <small v-if="documentForm.fileName">
              {{ documentForm.fileName }} · {{ Math.ceil(documentForm.size / 1024) }} KB
            </small>
          </div>
          <div class="row-actions">
            <button class="button secondary" type="button" @click="actionMode = ''">取消</button>
            <button class="button" type="submit" :disabled="pending || !documentForm.contentDigest">
              确认登记
            </button>
          </div>
        </form>

        <form
          v-else
          class="invoice-action-form"
          @submit.prevent="actionMode === 'void' ? voidDocument() : submitAction()"
        >
          <h3>
            {{
              {
                reject: '驳回并要求补充',
                retry: '重新进入开具中',
                'issue-failed': '标记开具失败',
                cancel: '取消发票申请',
                void: '作废发票文件',
              }[actionMode]
            }}
          </h3>
          <div class="form-field">
            <label for="invoice-action-reason">原因</label>
            <textarea id="invoice-action-reason" v-model="actionReason" rows="3" required />
          </div>
          <div class="row-actions">
            <button class="button secondary" type="button" @click="actionMode = ''">取消</button>
            <button
              class="button"
              :class="{ danger: ['reject', 'cancel', 'void'].includes(actionMode) }"
              type="submit"
              :disabled="pending || actionReason.trim().length < 2"
            >
              确认操作
            </button>
          </div>
        </form>
      </div>
    </template>
  </dialog>

  <section v-if="exportConfirmation" class="admin-panel inline-confirm-panel">
    <div>
      <p class="eyebrow">EXPORT SENSITIVE DATA</p>
      <h2>导出 {{ rows.length }} 条发票申请</h2>
      <p>文件包含申请单、订单号、发票抬头、金额、状态和申请时间。导出操作会记录审计日志。</p>
    </div>
    <div class="row-actions">
      <button class="button secondary" type="button" @click="exportConfirmation = false">
        取消
      </button>
      <button class="button" type="button" :disabled="exporting" @click="exportRows">
        {{ exporting ? '正在准备文件…' : '确认导出' }}
      </button>
    </div>
  </section>
</template>
