<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { AdminRegistrationOperationsDetail, EventId } from '@conference/contracts';
import { conferenceApi } from '../../lib/api';
import {
  deriveAdminInvoicePresentation,
  type AdminInvoiceActionCode,
} from '../../lib/invoice-presentation';
import { dateTime, money } from '../../lib/format';

type InvoiceContext = Extract<AdminRegistrationOperationsDetail['invoice'], { access: 'included' }>;
type InvoiceDetail = NonNullable<InvoiceContext['request']>;

const props = defineProps<{
  context: AdminRegistrationOperationsDetail['invoice'];
  invoiceRequired: boolean;
  orderStatus: string | undefined;
  eventId: EventId;
  canManage: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  success: [message: string];
  error: [message: string];
}>();

const busy = ref(false);
const actionMode = ref<
  '' | 'reject' | 'retry' | 'issue-failed' | 'cancel' | 'document' | 'replace' | 'void'
>('');
const actionReason = ref('');
const voidDocumentId = ref('');
const replaceDocumentId = ref('');
const selectedDocumentFile = ref<File>();
const documentForm = reactive({
  documentType: 'original' as 'original' | 'adjustment' | 'reissue',
  invoiceNumber: '',
  invoiceCode: '',
  externalReference: '',
  mediaType: 'application/pdf' as 'application/pdf' | 'application/ofd',
  size: 0,
  contentDigest: '',
  fileName: '',
});

const request = computed<InvoiceDetail | null>(() =>
  props.context.access === 'included' ? props.context.request : null,
);
const presentation = computed(() =>
  deriveAdminInvoicePresentation({
    access: props.context.access,
    invoiceRequired: props.invoiceRequired,
    ...(props.orderStatus
      ? {
          orderStatus: props.orderStatus as NonNullable<
            Parameters<typeof deriveAdminInvoicePresentation>[0]['orderStatus']
          >,
        }
      : {}),
    request: request.value
      ? {
          status: request.value.status,
          deliveryStatus: request.value.deliveryStatus,
          invoiceNumber: activeDocument.value?.invoiceNumber ?? null,
        }
      : null,
  }),
);
const activeDocuments = computed(
  () => request.value?.documents.filter((item) => !item.voidedAt) ?? [],
);
const activeDocument = computed(() => activeDocuments.value[0] ?? null);
const replaceableDocumentId = computed(() => {
  if (request.value?.status === 'issued') return activeDocument.value?.id ?? '';
  if (request.value?.status === 'voided' && activeDocuments.value.length === 0) {
    return request.value.documents[0]?.id ?? '';
  }
  return '';
});
const primaryActionLabel = computed(() => {
  const labels: Record<AdminInvoiceActionCode, string> = {
    approve_invoice: '审核通过',
    download_invoice: '下载发票',
    issue_invoice: '上传发票',
    request_invoice_details: '提醒补充资料',
    retry_invoice: '重新开票',
    send_invoice: '重新发送',
    void_invoice: '处理红冲',
  };
  const code = presentation.value.primaryActionCode;
  return code ? labels[code] : '';
});

function buyerTypeLabel(value: string | null) {
  if (value === 'company') return '企业';
  if (value === 'individual') return '个人';
  return '待提交';
}

function deliveryLabel(value: InvoiceDetail['deliveryStatus']) {
  return { not_sent: '未发送', queued: '发送中', sent: '已发送', failed: '发送失败' }[value];
}

function documentTypeLabel(value: string) {
  return { original: '原票', adjustment: '红冲票', reissue: '重开票' }[value] ?? value;
}

function logStatusLabel(value: string) {
  return (
    {
      awaiting_details: '待提交资料',
      pending_review: '资料待审核',
      issuing: '开票中',
      issued: '已开具',
      issue_failed: '开票失败',
      rejected: '资料已驳回',
      adjustment_required: '退款待调整',
      voided: '已作废',
      cancelled: '已取消',
    }[value] ?? value
  );
}

async function runPrimaryAction() {
  const code = presentation.value.primaryActionCode;
  if (!code || !request.value) return;
  if (code === 'approve_invoice') return approve();
  if (code === 'download_invoice' && activeDocument.value) {
    return downloadDocument(activeDocument.value);
  }
  if (code === 'issue_invoice') {
    documentForm.documentType = request.value.documents.length ? 'reissue' : 'original';
    actionMode.value = 'document';
    return;
  }
  if (code === 'send_invoice') return sendInvoice();
  if (code === 'retry_invoice') {
    actionMode.value = 'retry';
    actionReason.value = '重新进入开票流程';
    return;
  }
  if (code === 'void_invoice') {
    voidDocumentId.value = activeDocument.value?.id ?? '';
    actionMode.value = 'void';
    return;
  }
  return requestDetailsReminder();
}

async function requestDetailsReminder() {
  if (!request.value) return;
  busy.value = true;
  try {
    const result = await conferenceApi.requestInvoiceDetailsReminder(
      request.value.id,
      props.eventId,
    );
    emit(
      'success',
      result.alreadyQueued
        ? '10 分钟内已经发送过资料填写提醒，本次未重复发送。'
        : '发票资料填写入口已加入发送队列。',
    );
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '资料填写提醒发送失败');
  } finally {
    busy.value = false;
  }
}

async function approve() {
  if (!request.value) return;
  busy.value = true;
  try {
    await conferenceApi.approveInvoice(request.value.id, request.value.updatedAt, props.eventId);
    emit('success', '发票资料已审核通过，申请进入开票中。');
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票审核失败');
  } finally {
    busy.value = false;
  }
}

async function submitAction() {
  if (!request.value || !['reject', 'retry', 'issue-failed', 'cancel'].includes(actionMode.value)) {
    return;
  }
  if (actionReason.value.trim().length < 2) {
    emit('error', '请填写至少 2 个字符的处理原因。');
    return;
  }
  busy.value = true;
  try {
    await conferenceApi.invoiceAction(
      request.value.id,
      actionMode.value as 'reject' | 'retry' | 'issue-failed' | 'cancel',
      { reason: actionReason.value.trim(), expectedUpdatedAt: request.value.updatedAt },
      props.eventId,
    );
    emit('success', '发票状态已更新。');
    actionMode.value = '';
    actionReason.value = '';
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票状态更新失败');
  } finally {
    busy.value = false;
  }
}

async function chooseDocument(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  resetDocumentFile();
  const lowerName = file.name.toLocaleLowerCase();
  if (!lowerName.endsWith('.pdf') && !lowerName.endsWith('.ofd')) {
    input.value = '';
    emit('error', '发票文件仅支持 PDF 或 OFD。');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    input.value = '';
    emit('error', '发票文件不能超过 20 MB。');
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

function resetDocumentFile() {
  selectedDocumentFile.value = undefined;
  Object.assign(documentForm, {
    mediaType: 'application/pdf',
    size: 0,
    contentDigest: '',
    fileName: '',
  });
}

function openReplacement(documentId: string) {
  replaceDocumentId.value = documentId;
  actionReason.value = '重新上传发票文件';
  resetDocumentFile();
  actionMode.value = 'replace';
}

function openDelete(documentId: string) {
  voidDocumentId.value = documentId;
  actionReason.value = '';
  actionMode.value = 'void';
}

async function submitDocument() {
  if (!request.value || !selectedDocumentFile.value || !documentForm.invoiceNumber.trim()) {
    emit('error', '请填写发票号码并选择发票文件。');
    return;
  }
  busy.value = true;
  try {
    const upload = await conferenceApi.prepareInvoiceDocumentUpload(
      request.value.id,
      {
        fileName: documentForm.fileName,
        mediaType: documentForm.mediaType,
        size: documentForm.size,
        contentDigest: documentForm.contentDigest,
      },
      props.eventId,
    );
    const response = await fetch(upload.uploadUrl, {
      method: upload.method,
      headers: upload.headers,
      body: selectedDocumentFile.value,
    });
    if (!response.ok) throw new Error(`发票文件上传失败（${response.status}）`);
    await conferenceApi.addInvoiceDocument(
      request.value.id,
      {
        documentType: documentForm.documentType,
        invoiceNumber: documentForm.invoiceNumber.trim(),
        ...(documentForm.invoiceCode.trim()
          ? { invoiceCode: documentForm.invoiceCode.trim() }
          : {}),
        ...(documentForm.externalReference.trim()
          ? { externalReference: documentForm.externalReference.trim() }
          : {}),
        storageKey: upload.storageKey,
        mediaType: documentForm.mediaType,
        size: documentForm.size,
        contentDigest: documentForm.contentDigest,
        ...(documentForm.documentType !== 'original' && activeDocument.value
          ? { replacesDocumentId: activeDocument.value.id }
          : {}),
      },
      props.eventId,
    );
    emit('success', `发票 ${documentForm.invoiceNumber.trim()} 已上传并登记。`);
    actionMode.value = '';
    selectedDocumentFile.value = undefined;
    Object.assign(documentForm, {
      documentType: 'original',
      invoiceNumber: '',
      invoiceCode: '',
      externalReference: '',
      mediaType: 'application/pdf',
      size: 0,
      contentDigest: '',
      fileName: '',
    });
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票文件登记失败');
  } finally {
    busy.value = false;
  }
}

async function submitReplacement() {
  const currentRequest = request.value;
  const documentId = replaceDocumentId.value;
  const file = selectedDocumentFile.value;
  const reason = actionReason.value.trim();
  const fileMetadata = {
    fileName: documentForm.fileName,
    mediaType: documentForm.mediaType,
    size: documentForm.size,
    contentDigest: documentForm.contentDigest,
  };
  if (!currentRequest || !documentId || !file || reason.length < 2) {
    emit('error', '请选择发票文件并填写重新上传原因。');
    return;
  }
  busy.value = true;
  try {
    const upload = await conferenceApi.prepareInvoiceDocumentUpload(
      currentRequest.id,
      {
        ...fileMetadata,
        replaceDocumentId: documentId,
      },
      props.eventId,
    );
    const response = await fetch(upload.uploadUrl, {
      method: upload.method,
      headers: upload.headers,
      body: file,
    });
    if (!response.ok) throw new Error(`发票文件上传失败（${response.status}）`);
    await conferenceApi.replaceInvoiceDocumentFile(
      currentRequest.id,
      documentId,
      {
        storageKey: upload.storageKey,
        mediaType: fileMetadata.mediaType,
        size: fileMetadata.size,
        contentDigest: fileMetadata.contentDigest,
        reason,
        expectedUpdatedAt: currentRequest.updatedAt,
      },
      props.eventId,
    );
    emit('success', '发票文件已更新，用户前台将读取到最新文件。');
    actionMode.value = '';
    actionReason.value = '';
    replaceDocumentId.value = '';
    resetDocumentFile();
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票文件重新上传失败');
  } finally {
    busy.value = false;
  }
}

async function voidDocument() {
  const currentRequest = request.value;
  const documentId = voidDocumentId.value;
  const reason = actionReason.value.trim();
  if (!currentRequest || !documentId || reason.length < 2) {
    emit('error', '请选择发票文件并填写删除原因。');
    return;
  }
  busy.value = true;
  try {
    await conferenceApi.voidInvoiceDocument(
      currentRequest.id,
      documentId,
      reason,
      currentRequest.updatedAt,
      props.eventId,
    );
    emit('success', '发票文件已删除，用户前台下载已失效，操作记录仍会保留。');
    actionMode.value = '';
    actionReason.value = '';
    voidDocumentId.value = '';
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票作废失败');
  } finally {
    busy.value = false;
  }
}

async function sendInvoice() {
  if (!request.value) return;
  busy.value = true;
  try {
    await conferenceApi.sendInvoice(request.value.id, props.eventId);
    emit('success', `发票已加入发送队列，将发送至 ${request.value.maskedEmail ?? '接收邮箱'}。`);
    emit('refresh');
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '发票发送失败');
  } finally {
    busy.value = false;
  }
}

async function downloadDocument(document: InvoiceDetail['documents'][number]) {
  if (!request.value) return;
  try {
    await conferenceApi.downloadInvoiceDocument(
      request.value.id,
      document.id,
      `${document.invoiceNumber}.${document.mediaType === 'application/ofd' ? 'ofd' : 'pdf'}`,
      props.eventId,
    );
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '电子发票下载失败');
  }
}
</script>

<template>
  <section id="invoice" class="operation-card invoice-card" aria-labelledby="invoice-title">
    <header class="operation-card-head">
      <div>
        <p class="eyebrow">INVOICE</p>
        <h2 id="invoice-title">发票管理</h2>
      </div>
      <span class="state-pill" :class="`tone-${presentation.tone}`">
        {{ presentation.stageLabel }} · {{ presentation.substateLabel }}
      </span>
    </header>

    <div v-if="context.access === 'restricted'" class="permission-empty">
      <strong>发票信息受权限保护</strong>
      <p>拥有发票查看权限后，可在此处理资料、上传文件和发送发票。</p>
    </div>

    <div v-else-if="!request" class="invoice-empty">
      <div>
        <strong>{{ presentation.substateLabel }}</strong>
        <p>{{ presentation.summary }}</p>
      </div>
      <span>{{ invoiceRequired ? '已选择需要发票' : '报名时未选择发票' }}</span>
    </div>

    <template v-else>
      <div class="invoice-hero" :class="`tone-${presentation.tone}`">
        <div>
          <span>发票申请</span>
          <strong>{{ request.requestNo }}</strong>
          <small>{{ presentation.summary }}</small>
        </div>
        <div class="invoice-amount">
          <span>当前净开票金额</span>
          <strong>{{ money(request.netPaidAmount) }}</strong>
          <small>申请金额 {{ money(request.amount) }}</small>
        </div>
        <div v-if="canManage" class="invoice-primary-action">
          <button
            v-if="presentation.primaryActionCode"
            class="button"
            type="button"
            :disabled="busy"
            @click="runPrimaryAction"
          >
            {{ busy ? '处理中…' : primaryActionLabel }}
          </button>
        </div>
      </div>

      <dl class="invoice-facts">
        <div>
          <dt>抬头类型</dt>
          <dd>{{ buyerTypeLabel(request.buyerType) }}</dd>
        </div>
        <div>
          <dt>发票抬头</dt>
          <dd>{{ request.title || '待提交' }}</dd>
        </div>
        <div>
          <dt>税号</dt>
          <dd class="mono-code">{{ request.maskedTaxId || '待提交' }}</dd>
        </div>
        <div>
          <dt>发票内容</dt>
          <dd>{{ request.content || '待提交' }}</dd>
        </div>
        <div>
          <dt>接收邮箱</dt>
          <dd>{{ request.maskedEmail || '待提交' }}</dd>
        </div>
        <div>
          <dt>接收手机</dt>
          <dd>{{ request.maskedMobile || '待提交' }}</dd>
        </div>
        <div>
          <dt>发送状态</dt>
          <dd>{{ deliveryLabel(request.deliveryStatus) }}</dd>
        </div>
        <div>
          <dt>最近发送</dt>
          <dd>{{ request.lastSentAt ? dateTime(request.lastSentAt) : '尚未发送' }}</dd>
        </div>
      </dl>

      <div v-if="canManage" class="invoice-toolbar" aria-label="发票操作">
        <button
          v-if="request.status === 'pending_review'"
          class="text-action"
          type="button"
          :disabled="busy"
          @click="actionMode = 'reject'"
        >
          驳回资料
        </button>
        <button
          v-if="request.status === 'issuing'"
          class="text-action"
          type="button"
          :disabled="busy"
          @click="actionMode = 'document'"
        >
          上传发票
        </button>
        <button
          v-if="request.status === 'issued'"
          class="text-action"
          type="button"
          :disabled="busy"
          @click="sendInvoice"
        >
          {{ request.deliveryStatus === 'sent' ? '再次发送' : '发送发票' }}
        </button>
        <button
          v-if="!['cancelled', 'voided'].includes(request.status)"
          class="text-action danger-text"
          type="button"
          :disabled="busy"
          @click="actionMode = 'cancel'"
        >
          取消申请
        </button>
      </div>

      <form
        v-if="['reject', 'retry', 'issue-failed', 'cancel'].includes(actionMode)"
        class="inline-operation"
        @submit.prevent="submitAction"
      >
        <div>
          <strong>记录处理原因</strong>
          <p>原因会进入发票操作历史，便于后续追踪。</p>
        </div>
        <label>
          <span>处理原因</span>
          <input v-model="actionReason" maxlength="500" required />
        </label>
        <div class="inline-actions">
          <button
            class="button secondary compact"
            type="button"
            :disabled="busy"
            @click="actionMode = ''"
          >
            取消
          </button>
          <button class="button compact" type="submit" :disabled="busy">确认更新</button>
        </div>
      </form>

      <form v-if="actionMode === 'document'" class="document-form" @submit.prevent="submitDocument">
        <div class="document-form-head">
          <div>
            <strong>上传电子发票</strong>
            <p>支持 PDF、OFD，单个文件不超过 20 MB。</p>
          </div>
          <button class="text-action" type="button" :disabled="busy" @click="actionMode = ''">
            收起
          </button>
        </div>
        <div class="document-form-grid">
          <label>
            <span>文件类型</span>
            <select v-model="documentForm.documentType">
              <option value="original">原票</option>
              <option value="adjustment">红冲票</option>
              <option value="reissue">重开票</option>
            </select>
          </label>
          <label>
            <span>发票号码</span>
            <input v-model="documentForm.invoiceNumber" required />
          </label>
          <label>
            <span>发票代码</span>
            <input v-model="documentForm.invoiceCode" />
          </label>
          <label>
            <span>外部系统编号</span>
            <input v-model="documentForm.externalReference" />
          </label>
          <label class="file-field">
            <span>发票文件</span>
            <input
              type="file"
              accept=".pdf,.ofd,application/pdf,application/ofd"
              required
              @change="chooseDocument"
            />
            <small>{{ documentForm.fileName || '请选择文件' }}</small>
          </label>
        </div>
        <div class="inline-actions">
          <button class="button" type="submit" :disabled="busy">
            {{ busy ? '上传中…' : '上传并登记' }}
          </button>
        </div>
      </form>

      <form
        v-if="actionMode === 'replace'"
        class="document-form replacement-form"
        @submit.prevent="submitReplacement"
      >
        <div class="document-form-head">
          <div>
            <strong>重新上传发票文件</strong>
            <p>新文件验证成功后才会替换当前文件，用户前台随后读取最新版本。</p>
          </div>
          <button
            class="text-action"
            type="button"
            :disabled="busy"
            @click="
              actionMode = '';
              replaceDocumentId = '';
              actionReason = '';
              resetDocumentFile();
            "
          >
            收起
          </button>
        </div>
        <div class="replacement-form-grid">
          <label class="file-field">
            <span>最新发票文件</span>
            <input
              type="file"
              accept=".pdf,.ofd,application/pdf,application/ofd"
              required
              @change="chooseDocument"
            />
            <small>{{ documentForm.fileName || '请选择 PDF 或 OFD 文件' }}</small>
          </label>
          <label>
            <span>重新上传原因</span>
            <input v-model="actionReason" maxlength="500" required />
          </label>
        </div>
        <div class="inline-actions">
          <button class="button" type="submit" :disabled="busy">
            {{ busy ? '上传中…' : '上传并替换' }}
          </button>
        </div>
      </form>

      <form v-if="actionMode === 'void'" class="inline-operation" @submit.prevent="voidDocument">
        <label>
          <span>删除文件</span>
          <select v-model="voidDocumentId" required>
            <option value="" disabled>请选择</option>
            <option v-for="document in activeDocuments" :key="document.id" :value="document.id">
              {{ document.invoiceNumber }}
            </option>
          </select>
        </label>
        <label>
          <span>删除原因</span>
          <input v-model="actionReason" maxlength="500" required />
        </label>
        <div class="inline-actions">
          <button
            class="button secondary compact"
            type="button"
            :disabled="busy"
            @click="actionMode = ''"
          >
            取消
          </button>
          <button class="button danger compact" type="submit" :disabled="busy">确认删除</button>
        </div>
      </form>

      <section class="invoice-subsection">
        <header>
          <strong>发票文件</strong><span>{{ request.documents.length }} 个</span>
        </header>
        <ul v-if="request.documents.length" class="invoice-document-list">
          <li
            v-for="document in request.documents"
            :key="document.id"
            :class="{ voided: document.voidedAt }"
          >
            <div>
              <span>{{ documentTypeLabel(document.documentType) }}</span>
              <strong>{{ document.invoiceNumber }}</strong>
              <small>
                {{ document.mediaType === 'application/ofd' ? 'OFD' : 'PDF' }} ·
                {{ dateTime(document.issuedAt) }}
              </small>
              <small v-if="document.voidedAt">已删除，保留记录：{{ document.voidReason }}</small>
            </div>
            <div class="document-actions">
              <button
                v-if="!document.voidedAt"
                class="button secondary compact"
                type="button"
                :disabled="busy"
                @click="downloadDocument(document)"
              >
                下载
              </button>
              <button
                v-if="canManage && document.id === replaceableDocumentId"
                class="button secondary compact"
                type="button"
                :disabled="busy"
                @click="openReplacement(document.id)"
              >
                重新上传
              </button>
              <button
                v-if="canManage && !document.voidedAt"
                class="document-delete-action"
                type="button"
                :disabled="busy"
                @click="openDelete(document.id)"
              >
                删除
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="subsection-empty">尚未上传发票文件。</p>
      </section>

      <details class="invoice-history">
        <summary>查看发票操作历史（{{ request.logs.length }}）</summary>
        <ol>
          <li v-for="log in [...request.logs].reverse()" :key="log.id">
            <span aria-hidden="true"></span>
            <div>
              <strong>{{ logStatusLabel(log.toStatus) }}</strong>
              <p>{{ log.reason }}</p>
              <small>{{ log.actorName || '系统' }} · {{ dateTime(log.createdAt) }}</small>
            </div>
          </li>
        </ol>
      </details>
    </template>
  </section>
</template>

<style scoped>
.operation-card {
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  scroll-margin-top: 96px;
}
.operation-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px 15px;
  border-bottom: 1px solid var(--line);
}
.operation-card-head h2 {
  margin: 3px 0 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 19px;
  font-weight: 600;
}
.state-pill {
  display: inline-flex;
  min-height: 27px;
  align-items: center;
  padding: 5px 9px;
  border-radius: 5px;
  background: #f0f2f3;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
  font-weight: 700;
}
.tone-success {
  background: #edf6f1;
  color: #25664e;
}
.tone-warning {
  background: #fff5df;
  color: #8a5c0c;
}
.tone-danger {
  background: #fff0ed;
  color: #b83f32;
}
.tone-info {
  background: #edf3fa;
  color: var(--blue);
}
.permission-empty,
.invoice-empty {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 28px 20px;
  color: var(--muted);
}
.permission-empty {
  display: block;
}
.permission-empty strong,
.invoice-empty strong {
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
}
.permission-empty p,
.invoice-empty p {
  margin: 5px 0 0;
  font-size: var(--registration-font-body, 14px);
  line-height: 1.7;
}
.invoice-empty > span {
  font-size: var(--registration-font-label, 12px);
}
.invoice-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(170px, 0.4fr) auto;
  gap: 24px;
  align-items: center;
  padding: 19px 20px;
  background: #f7f9fb;
  border-bottom: 1px solid var(--line);
}
.invoice-hero > div > span,
.invoice-hero small {
  display: block;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
.invoice-hero strong {
  display: block;
  margin: 5px 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 600;
}
.invoice-amount strong {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.invoice-primary-action {
  justify-self: end;
}
.invoice-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  border-bottom: 1px solid var(--line);
}
.invoice-facts > div {
  min-width: 0;
  padding: 13px 16px;
  border-right: 1px solid rgb(23 34 51 / 7%);
  border-bottom: 1px solid rgb(23 34 51 / 7%);
}
.invoice-facts > div:nth-child(4n) {
  border-right: 0;
}
.invoice-facts dt {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
.invoice-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
  font-weight: 600;
}
.invoice-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 18px;
  padding: 11px 20px;
  border-bottom: 1px solid var(--line);
}
.text-action {
  min-height: 36px;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--blue);
  cursor: pointer;
  font: inherit;
  font-size: var(--registration-font-control, 13px);
  font-weight: 700;
}
.text-action:disabled,
.document-delete-action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.danger-text {
  color: var(--red);
}
.inline-operation {
  display: grid;
  grid-template-columns: minmax(180px, 0.6fr) minmax(240px, 1fr) auto;
  gap: 16px;
  align-items: end;
  padding: 16px 20px;
  background: #f8fafb;
  border-bottom: 1px solid var(--line);
}
.inline-operation strong,
.document-form strong {
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
}
.inline-operation p,
.document-form p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
.inline-operation label,
.document-form label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
.inline-operation input,
.inline-operation select,
.document-form input,
.document-form select {
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: #fff;
  color: var(--ink);
  font: inherit;
}
.inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.document-form {
  padding: 16px 20px;
  background: #f8fafb;
  border-bottom: 1px solid var(--line);
}
.document-form-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
}
.document-form-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.replacement-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 0.55fr);
  gap: 12px;
}
.replacement-form-grid .file-field {
  grid-column: auto;
}
.file-field {
  grid-column: 1 / -1;
}
.file-field input {
  padding: 6px;
}
.file-field small {
  color: var(--blue);
}
.document-form > .inline-actions {
  margin-top: 14px;
}
.invoice-subsection {
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}
.invoice-subsection > header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
}
.invoice-subsection > header span {
  color: var(--muted);
}
.invoice-document-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.invoice-document-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 12px;
  background: #f7f8f8;
  border: 1px solid #edf0f1;
  border-radius: 5px;
}
.invoice-document-list li.voided > div:first-child {
  opacity: 0.58;
}
.invoice-document-list li > div {
  min-width: 0;
}
.invoice-document-list li span {
  margin-right: 8px;
  color: var(--blue);
  font-size: var(--registration-font-control, 13px);
  font-weight: 700;
}
.invoice-document-list li strong {
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
}
.invoice-document-list li small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
.document-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.document-actions .button,
.document-delete-action {
  min-height: 40px;
}
.document-delete-action {
  padding: 0 10px;
  background: transparent;
  border: 0;
  color: var(--red);
  cursor: pointer;
  font: inherit;
  font-size: var(--registration-font-control, 13px);
  font-weight: 700;
}
.subsection-empty {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  font-size: var(--registration-font-body, 14px);
  text-align: center;
}
.invoice-history {
  padding: 0 20px;
}
.invoice-history summary {
  min-height: 48px;
  padding: 16px 0;
  color: var(--blue);
  cursor: pointer;
  font-size: var(--registration-font-control, 13px);
  font-weight: 700;
}
.invoice-history ol {
  margin: 0 0 18px;
  padding: 0;
  list-style: none;
}
.invoice-history li {
  display: grid;
  grid-template-columns: 9px 1fr;
  gap: 10px;
  padding: 9px 0;
}
.invoice-history li > span {
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border: 2px solid #9eabb6;
  border-radius: 50%;
}
.invoice-history strong {
  color: var(--ink);
  font-size: var(--registration-font-body, 14px);
}
.invoice-history p {
  margin: 3px 0;
  color: #44515d;
  font-size: var(--registration-font-body, 14px);
}
.invoice-history small {
  color: var(--muted);
  font-size: var(--registration-font-label, 12px);
}
@media (max-width: 1000px) {
  .invoice-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .invoice-facts > div:nth-child(2n) {
    border-right: 0;
  }
  .document-form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .replacement-form-grid {
    grid-template-columns: 1fr;
  }
  .inline-operation {
    grid-template-columns: 1fr;
  }
  .inline-actions {
    justify-content: flex-start;
  }
}
@media (max-width: 680px) {
  .invoice-hero {
    grid-template-columns: 1fr;
  }
  .invoice-primary-action {
    justify-self: start;
  }
  .invoice-facts,
  .document-form-grid {
    grid-template-columns: 1fr;
  }
  .invoice-facts > div {
    border-right: 0;
  }
  .file-field {
    grid-column: auto;
  }
  .invoice-document-list li {
    align-items: flex-start;
    flex-direction: column;
  }
  .document-actions {
    justify-content: flex-start;
    width: 100%;
  }
  .operation-card-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .invoice-empty {
    flex-direction: column;
  }
}
</style>
