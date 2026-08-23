<script setup lang="ts">
import { nextTick, watch } from 'vue';
import {
  ATTENDEE_SHOWCASE_CONSENT_VERSION,
  ATTENDEE_INDUSTRY_OPTIONS,
  DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS,
  publicEventHomePath,
  publicEventScopedPath,
  type AttendeeNeedsProfile,
  type AttendeeShowcaseProfile,
  type AttendeeShowcaseVisibleFields,
  type UpdateAttendeeShowcase,
} from '@conference/contracts';
import QRCode from 'qrcode.vue';
import { useAttendeePosterRefresh } from '~/composables/useAttendeePosterRefresh';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  activeFlowStep,
  enabledFlowSteps,
  resolveEventExperience,
} from '~/composables/useEventExperience';
import {
  attendeeAvatarInitial,
  attendeePosterFilename,
  resolveAttendeePosterContent,
} from '~/utils/attendee-poster';
import {
  attendeeShowcaseApiValidationIssues,
  attendeeShowcaseValidationIssues,
  type AttendeeShowcaseValidationField,
  type AttendeeShowcaseValidationIssue,
} from '~/utils/attendee-showcase-validation';

const route = useRoute();
const customer = useCustomerSession();
const conferenceApi = useConferenceApi();
const event = conferenceApi.eventState;
const registrationId = String(route.params.id);
const loading = ref(true);
const saving = ref(false);
const uploading = ref(false);
const downloading = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const validationDialogOpen = ref(false);
const validationIssues = ref<AttendeeShowcaseValidationIssue[]>([]);
const profile = ref<AttendeeShowcaseProfile | null>(null);
const attendeeNeedsProfile = ref<AttendeeNeedsProfile | null>(null);
const privateAvatarUrl = ref<string | null>(null);
const posterCanvas = ref<HTMLCanvasElement | null>(null);
const qrHolder = ref<HTMLElement | null>(null);

const form = reactive({
  displayName: '',
  company: '',
  title: '',
  industryCode: '',
  businessIntro: '',
  businessUrl: '',
  contactPhone: '',
  contactEmail: '',
  wechatId: '',
  isPublic: false,
  visibleFields: { ...DEFAULT_ATTENDEE_SHOWCASE_VISIBLE_FIELDS } as AttendeeShowcaseVisibleFields,
});

const showcaseUrl = computed(() => {
  const value = profile.value;
  const path =
    value?.effectivePublic && value.publicSlug
      ? publicEventScopedPath(`/members/${encodeURIComponent(value.publicSlug)}`, value.eventSlug)
      : publicEventHomePath(value?.eventSlug ?? String(route.query.event ?? ''));
  if (!import.meta.client) return path;
  return new URL(path, window.location.origin).toString();
});

const homeHref = computed(() =>
  profile.value ? publicEventHomePath(profile.value.eventSlug) : '/',
);

const accountHref = computed(() =>
  profile.value ? publicEventScopedPath('/account', profile.value.eventSlug) : '/account',
);

const invoiceHref = computed(() =>
  profile.value
    ? publicEventScopedPath(
        `/account/invoices/${encodeURIComponent(profile.value.orderId)}`,
        profile.value.eventSlug,
      )
    : '/account?section=invoices',
);
const needsHref = computed(() =>
  profile.value
    ? publicEventScopedPath(
        `/account/registrations/${encodeURIComponent(registrationId)}/needs`,
        profile.value.eventSlug,
      )
    : `/account/registrations/${encodeURIComponent(registrationId)}/needs`,
);
const attendeeNeedsEntryEnabled = computed(
  () => Boolean(attendeeNeedsProfile.value?.id) || Boolean(attendeeNeedsProfile.value?.canCreate),
);

const publicPreviewHref = computed(() => {
  if (!profile.value?.publicSlug) return '';
  return publicEventScopedPath(
    `/members/${encodeURIComponent(profile.value.publicSlug)}`,
    profile.value.eventSlug,
  );
});
const posterContent = computed(() =>
  resolveAttendeePosterContent({
    displayName: form.displayName,
    company: form.company,
    title: form.title,
    industryCode: form.industryCode,
    businessIntro: form.businessIntro,
    avatarUrl: privateAvatarUrl.value,
    visibleFields: form.visibleFields,
  }),
);
const posterEventLine = computed(() => {
  if (!event.value?.startsAt) return event.value?.city || '大会现场';
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: event.value.timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(event.value.startsAt));
  return [date, event.value.city].filter(Boolean).join(' · ');
});
const posterEventMark = computed(
  () => event.value?.shortName?.trim() || profile.value?.eventName || '大会现场',
);
const posterLocation = computed(() => event.value?.city?.trim() || '大会现场');
const flowSteps = computed(() =>
  enabledFlowSteps(event.value, {
    paymentRequired: profile.value?.paymentRequired ?? true,
    invoiceRequired: false,
  }),
);
const activeStep = computed(() => activeFlowStep(flowSteps.value, 'member-profile'));

function syncForm(value: AttendeeShowcaseProfile) {
  form.displayName = value.displayName ?? '';
  form.company = value.company ?? '';
  form.title = value.title ?? '';
  form.industryCode = value.industryCode ?? '';
  form.businessIntro = value.businessIntro ?? '';
  form.businessUrl = value.businessUrl?.replace(/^https?:\/\//iu, '') ?? '';
  form.contactPhone = value.contactPhone ?? '';
  form.contactEmail = value.contactEmail ?? '';
  form.wechatId = value.wechatId ?? '';
  form.isPublic = value.isPublic;
  form.visibleFields = { ...value.visibleFields };
}

async function syncPrivateAvatar() {
  if (privateAvatarUrl.value) URL.revokeObjectURL(privateAvatarUrl.value);
  privateAvatarUrl.value = null;
  if (profile.value?.avatarStatus !== 'ready') return;
  try {
    const blob = await customer.attendeeAvatarBlob(registrationId);
    privateAvatarUrl.value = URL.createObjectURL(blob);
  } catch {
    // The initials treatment remains available when the private image cannot be loaded.
  }
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    let value: AttendeeShowcaseProfile;
    try {
      value = await customer.attendeeShowcase(registrationId);
    } catch (error) {
      const checkout = conferenceApi.readCheckout();
      if (
        checkout?.registration.id !== registrationId ||
        !checkout.orderAccessToken ||
        !checkout.order.id
      ) {
        throw error;
      }
      await customer.claimRegistration(checkout.order.id, checkout.orderAccessToken);
      value = await customer.attendeeShowcase(registrationId);
    }
    profile.value = value;
    syncForm(value);
    [event.value, attendeeNeedsProfile.value] = await Promise.all([
      conferenceApi.getEvent(value.eventSlug),
      customer.attendeeNeeds(registrationId).catch(() => null),
    ]);
    await syncPrivateAvatar();
  } catch (error) {
    const failure = error as { data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '参会名片暂时无法加载';
  } finally {
    loading.value = false;
  }
}

function nullable(value: string) {
  return value.trim() || null;
}

function showcaseInput(): UpdateAttendeeShowcase {
  return {
    version: profile.value?.version ?? 0,
    displayName: nullable(form.displayName),
    company: nullable(form.company),
    title: nullable(form.title),
    industryCode: form.industryCode
      ? (form.industryCode as (typeof ATTENDEE_INDUSTRY_OPTIONS)[number]['code'])
      : null,
    businessIntro: nullable(form.businessIntro),
    businessUrl: nullable(form.businessUrl),
    contactPhone: nullable(form.contactPhone),
    contactEmail: nullable(form.contactEmail),
    wechatId: nullable(form.wechatId),
    isPublic: form.isPublic,
    visibleFields: { ...form.visibleFields },
    consentVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
  };
}

function showValidationIssues(issues: AttendeeShowcaseValidationIssue[]) {
  validationIssues.value = issues;
  validationDialogOpen.value = true;
}

function validationIssueFor(field: AttendeeShowcaseValidationField) {
  return validationIssues.value.find((issue) => issue.field === field);
}

async function focusValidationTarget(targetId: string) {
  validationDialogOpen.value = false;
  await nextTick();
  const target = document.getElementById(targetId);
  if (!target) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'center',
  });
  target.focus({ preventScroll: true });
}

async function save() {
  if (!profile.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  const input = showcaseInput();
  const issues = attendeeShowcaseValidationIssues(input);
  if (issues.length) {
    showValidationIssues(issues);
    return;
  }
  saving.value = true;
  try {
    const value = await customer.updateAttendeeShowcase(registrationId, input);
    profile.value = value;
    syncForm(value);
    validationIssues.value = [];
    successMessage.value = value.effectivePublic
      ? '参会名片已保存，并已加入大会报名会员展示'
      : '参会名片已保存';
  } catch (error) {
    const failure = error as {
      data?: { message?: string; details?: { issues?: unknown } };
    };
    const apiIssues = attendeeShowcaseApiValidationIssues(failure.data?.details?.issues);
    if (apiIssues.length) {
      showValidationIssues(apiIssues);
      return;
    }
    errorMessage.value = failure.data?.message ?? '保存失败，请检查填写内容后重试';
  } finally {
    saving.value = false;
  }
}

watch(
  form,
  () => {
    if (!profile.value || !validationIssues.value.length) return;
    validationIssues.value = attendeeShowcaseValidationIssues(showcaseInput());
  },
  { deep: true },
);

async function uploadAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  ) {
    errorMessage.value = '请选择 5MB 以内的 JPG、PNG 或 WebP 图片';
    input.value = '';
    return;
  }
  uploading.value = true;
  errorMessage.value = '';
  try {
    profile.value = await customer.uploadAttendeeAvatar(registrationId, file);
    successMessage.value = '头像已上传，正在生成安全清晰的展示图';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const value = await customer.attendeeShowcase(registrationId);
      profile.value = value;
      if (value.avatarStatus !== 'processing') break;
    }
    await syncPrivateAvatar();
  } catch (error) {
    const failure = error as { data?: { message?: string } };
    errorMessage.value =
      failure.data?.message ?? (error instanceof Error ? error.message : '头像上传失败');
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function removeAvatar() {
  profile.value = await customer.removeAttendeeAvatar(registrationId);
  await syncPrivateAvatar();
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

function drawPosterGrid(context: CanvasRenderingContext2D) {
  context.save();
  context.strokeStyle = 'rgba(138, 162, 210, 0.09)';
  context.lineWidth = 1;
  for (let x = 72; x <= 1008; x += 156) {
    context.beginPath();
    context.moveTo(x, 64);
    context.lineTo(x, 1376);
    context.stroke();
  }
  for (let y = 96; y <= 1368; y += 112) {
    context.beginPath();
    context.moveTo(64, y);
    context.lineTo(1016, y);
    context.stroke();
  }
  context.restore();
}

function drawPill(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { background: string; color: string; font?: string },
) {
  context.font = options.font ?? '700 20px "Arial Narrow", "PingFang SC", sans-serif';
  const width = Math.ceil(context.measureText(text).width) + 44;
  context.fillStyle = options.background;
  roundedRect(context, x, y, width, 48, 24);
  context.fill();
  context.fillStyle = options.color;
  context.fillText(text, x + 22, y + 31);
  return width;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const characters = Array.from(text);
  let line = '';
  let truncated = false;
  const lines: string[] = [];
  for (const character of characters) {
    const candidate = `${line}${character}`;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  lines.slice(0, maxLines).forEach((value, index) => {
    const finalValue = truncated && index === maxLines - 1 ? `${value.slice(0, -1)}…` : value;
    context.fillText(finalValue, x, y + index * lineHeight);
  });
}

async function drawAvatar(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const avatarUrl = posterContent.value.avatarUrl;
  if (avatarUrl) {
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('avatar load failed'));
        image.src = avatarUrl;
      });
      context.save();
      roundedRect(context, x, y, size, size, 26);
      context.clip();
      context.drawImage(image, x, y, size, size);
      context.restore();
      context.strokeStyle = 'rgba(245, 247, 250, 0.22)';
      context.lineWidth = 2;
      roundedRect(context, x, y, size, size, 26);
      context.stroke();
      return;
    } catch {
      // The initials treatment keeps poster export available when image CORS is unavailable.
    }
  }
  context.fillStyle = '#142443';
  roundedRect(context, x, y, size, size, 26);
  context.fill();
  context.strokeStyle = 'rgba(76, 121, 255, 0.62)';
  context.lineWidth = 2;
  roundedRect(context, x, y, size, size, 26);
  context.stroke();
  context.fillStyle = '#f3f5f8';
  context.font = '800 82px "Arial Narrow", "PingFang SC", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(
    attendeeAvatarInitial(posterContent.value.displayName),
    x + size / 2,
    y + size / 2,
  );
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

async function renderPoster() {
  const canvas = posterCanvas.value;
  const qrCanvas = qrHolder.value?.querySelector('canvas');
  if (!canvas || !qrCanvas || !profile.value) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#07111f';
  context.fillRect(0, 0, 1080, 1440);
  drawPosterGrid(context);

  context.fillStyle = '#c9ff5a';
  context.fillRect(72, 72, 14, 14);
  context.fillStyle = '#9eabc0';
  context.font = '700 20px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('CONFIRMED ATTENDEE', 104, 86);
  context.textAlign = 'right';
  context.fillText(
    `NO.${String(profile.value.sequence ?? 1).padStart(3, '0')}  /  ${posterLocation.value}`,
    1008,
    86,
  );
  context.textAlign = 'left';

  context.fillStyle = '#f3f5f8';
  context.font = '800 54px "Arial Narrow", "PingFang SC", sans-serif';
  wrapText(context, profile.value.eventName, 72, 174, 760, 64, 2);
  context.fillStyle = '#8fa1bf';
  context.font = '600 22px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText(`${posterEventMark.value}  /  ${posterEventLine.value}`, 72, 258);

  context.fillStyle = '#c9ff5a';
  context.font = '800 20px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('I AM ATTENDING  /  已确认参会', 72, 430);
  const displayName = posterContent.value.displayName || '大会报名会员';
  const displayNameLength = Array.from(displayName).length;
  const displayNameSize =
    displayNameLength <= 4 ? 92 : displayNameLength <= 6 ? 76 : displayNameLength <= 9 ? 62 : 54;
  context.fillStyle = '#f3f5f8';
  context.font = `900 ${displayNameSize}px "Arial Narrow", "PingFang SC", sans-serif`;
  wrapText(context, displayName, 72, 548, 610, displayNameSize + 14, 2);
  context.fillStyle = '#b8c2d3';
  context.font = '600 29px "Arial Narrow", "PingFang SC", sans-serif';
  const identity =
    [posterContent.value.company, posterContent.value.title].filter(Boolean).join('  /  ') ||
    '期待在大会现场与你见面';
  wrapText(context, identity, 72, 750, 610, 44, 2);
  await drawAvatar(context, 736, 412, 272);

  const industry = ATTENDEE_INDUSTRY_OPTIONS.find(
    (item) => item.code === posterContent.value.industryCode,
  )?.label;
  if (industry) {
    drawPill(context, industry, 72, 824, {
      background: '#173266',
      color: '#dbe5ff',
    });
  }

  context.strokeStyle = 'rgba(158, 171, 192, 0.3)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(72, 922);
  context.lineTo(1008, 922);
  context.stroke();
  context.fillStyle = '#4c79ff';
  context.font = '800 18px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('LOOKING TO CONNECT  /  我在做的事', 72, 980);
  context.fillStyle = '#eef2f8';
  context.font = '650 33px "Arial Narrow", "PingFang SC", sans-serif';
  wrapText(
    context,
    posterContent.value.businessIntro || '正在寻找行业伙伴、业务交流与新的合作机会。',
    72,
    1040,
    650,
    50,
    3,
  );

  context.fillStyle = '#f3f5f8';
  roundedRect(context, 780, 1088, 228, 228, 18);
  context.fill();
  context.drawImage(qrCanvas, 798, 1106, 192, 192);
  context.fillStyle = '#c9ff5a';
  context.font = '800 19px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('SCAN TO CONNECT', 72, 1236);
  context.fillStyle = '#f3f5f8';
  context.font = '700 28px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('现场见，一起聊聊', 72, 1282);
  context.fillStyle = '#8fa1bf';
  context.font = '500 19px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText('扫码查看大会信息与我的参会名片', 72, 1321);

  context.fillStyle = '#4c79ff';
  context.fillRect(72, 1362, 72, 6);
  context.fillStyle = '#7e8da6';
  context.font = '600 17px "Arial Narrow", "PingFang SC", sans-serif';
  context.fillText(`${posterEventMark.value}  ·  MEMBER PASS`, 168, 1370);
}

async function downloadPoster() {
  const canvas = posterCanvas.value;
  if (!canvas) return;
  downloading.value = true;
  await renderPoster();
  canvas.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = attendeePosterFilename(
      posterContent.value.displayName,
      profile.value?.eventName ?? '大会',
      profile.value?.sequence ?? 1,
    );
    link.click();
    URL.revokeObjectURL(link.href);
    downloading.value = false;
  }, 'image/png');
}

onMounted(load);
onBeforeUnmount(() => {
  if (privateAvatarUrl.value) URL.revokeObjectURL(privateAvatarUrl.value);
});
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !profile.value) void load();
  },
);
useAttendeePosterRefresh({
  loading,
  profileVersion: () => profile.value?.version,
  avatarUrl: privateAvatarUrl,
  showcaseUrl,
  hasProfile: () => Boolean(profile.value),
  render: renderPoster,
});

useHead(() => ({
  title: `完善参会名片${profile.value ? ` · ${profile.value.eventName}` : ''}`,
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
}));
</script>

<template>
  <div class="flow-page showcase-page">
    <FlowHeader />
    <AttendeeShowcaseValidationDialog
      :open="validationDialogOpen"
      :issues="validationIssues"
      @close="validationDialogOpen = false"
      @navigate="focusValidationTarget"
    />
    <main id="main-content" class="showcase-shell">
      <header class="showcase-intro">
        <p class="flow-eyebrow">STEP 05 · ATTENDEE PROFILE</p>
        <h1>完善个人信息，让同行者提前认识你</h1>
        <p>
          保存后可生成专属报名海报。开启主页展示时，系统会按报名顺序推荐你的参会名片；每项内容都由你决定是否公开。
        </p>
      </header>

      <FlowStepper
        v-if="profile"
        class="showcase-stepper"
        :active="activeStep"
        :payment-required="profile.paymentRequired"
        :steps="flowSteps.map((step) => step.title)"
        :variant="resolveEventExperience(event).registrationFlow.progressVariant"
      />

      <p v-if="loading" class="showcase-state">正在准备你的参会名片…</p>
      <p v-else-if="errorMessage && !profile" class="showcase-state is-error">{{ errorMessage }}</p>

      <template v-else-if="profile">
        <section class="showcase-layout">
          <form class="profile-editor" novalidate @submit.prevent="save">
            <div class="editor-section editor-identity">
              <div class="editor-heading">
                <div>
                  <span>01</span>
                  <h2>身份与头像</h2>
                </div>
                <strong>{{ profile.completion.score }}% 完成</strong>
              </div>

              <div class="avatar-row">
                <div
                  class="avatar-preview"
                  :class="{ 'is-processing': profile.avatarStatus === 'processing' }"
                >
                  <img v-if="privateAvatarUrl" :src="privateAvatarUrl" alt="当前参会头像" />
                  <span v-else>{{ attendeeAvatarInitial(form.displayName) }}</span>
                </div>
                <div>
                  <label class="upload-action">
                    {{ uploading ? '正在处理…' : '上传头像' }}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      :disabled="uploading"
                      @change="uploadAvatar"
                    />
                  </label>
                  <button
                    v-if="profile.avatarStatus !== 'none'"
                    type="button"
                    class="text-action"
                    @click="removeAvatar"
                  >
                    移除头像
                  </button>
                  <p>JPG、PNG 或 WebP，最大 5MB。系统会自动裁切并清理图片元数据。</p>
                </div>
                <label class="visibility-toggle">
                  <input v-model="form.visibleFields.avatar" type="checkbox" />
                  对外展示
                </label>
              </div>

              <div class="field-grid">
                <label
                  class="field-block"
                  :class="{ 'is-invalid': validationIssueFor('displayName') }"
                >
                  <span>姓名 <em v-if="form.isPublic" class="required-mark">公开时必填</em></span>
                  <input
                    id="showcase-display-name"
                    v-model="form.displayName"
                    maxlength="120"
                    autocomplete="name"
                    :aria-invalid="Boolean(validationIssueFor('displayName'))"
                    :aria-describedby="
                      validationIssueFor('displayName') ? 'showcase-display-name-error' : undefined
                    "
                  />
                  <span
                    v-if="validationIssueFor('displayName')"
                    id="showcase-display-name-error"
                    class="field-error"
                  >
                    {{ validationIssueFor('displayName')?.message }}
                  </span>
                  <small><input v-model="form.visibleFields.displayName" type="checkbox" />
                    公开姓名</small>
                </label>
                <label
                  class="field-block"
                  :class="{ 'is-invalid': validationIssueFor('industryCode') }"
                >
                  <span>主行业 <em v-if="form.isPublic" class="required-mark">公开时必填</em></span>
                  <select
                    id="showcase-industry-code"
                    v-model="form.industryCode"
                    :aria-invalid="Boolean(validationIssueFor('industryCode'))"
                    :aria-describedby="
                      validationIssueFor('industryCode')
                        ? 'showcase-industry-code-error'
                        : undefined
                    "
                  >
                    <option value="">请选择行业</option>
                    <option
                      v-for="item in ATTENDEE_INDUSTRY_OPTIONS"
                      :key="item.code"
                      :value="item.code"
                    >
                      {{ item.label }}
                    </option>
                  </select>
                  <span
                    v-if="validationIssueFor('industryCode')"
                    id="showcase-industry-code-error"
                    class="field-error"
                  >
                    {{ validationIssueFor('industryCode')?.message }}
                  </span>
                  <small><input v-model="form.visibleFields.industry" type="checkbox" /> 公开行业</small>
                </label>
                <label class="field-block">
                  <span>公司 / 组织</span>
                  <input
                    id="showcase-company"
                    v-model="form.company"
                    maxlength="160"
                    autocomplete="organization"
                  />
                  <small><input v-model="form.visibleFields.company" type="checkbox" /> 公开公司</small>
                </label>
                <label class="field-block">
                  <span>职位</span>
                  <input
                    id="showcase-title"
                    v-model="form.title"
                    maxlength="100"
                    autocomplete="organization-title"
                  />
                  <small><input v-model="form.visibleFields.title" type="checkbox" /> 公开职位</small>
                </label>
              </div>
            </div>

            <div class="editor-section">
              <div class="editor-heading">
                <div>
                  <span>02</span>
                  <h2>业务介绍</h2>
                </div>
              </div>
              <label class="field-block is-wide">
                <span>你在做什么 / 希望认识谁</span>
                <textarea
                  id="showcase-business-intro"
                  v-model="form.businessIntro"
                  maxlength="2000"
                  rows="6"
                  placeholder="例如：帮助消费品牌建立 GEO 内容体系，希望认识品牌市场与 AI 产品方向的伙伴。"
                />
                <small><input v-model="form.visibleFields.businessIntro" type="checkbox" />
                  公开业务介绍</small>
              </label>
              <label class="field-block is-wide">
                <span>公司或项目网址</span>
                <input
                  id="showcase-business-url"
                  v-model="form.businessUrl"
                  type="text"
                  inputmode="url"
                  placeholder="www.example.com"
                  :aria-invalid="Boolean(validationIssueFor('businessUrl'))"
                  :aria-describedby="
                    validationIssueFor('businessUrl') ? 'showcase-business-url-error' : undefined
                  "
                />
                <span
                  v-if="validationIssueFor('businessUrl')"
                  id="showcase-business-url-error"
                  class="field-error"
                >
                  {{ validationIssueFor('businessUrl')?.message }}
                </span>
                <small><input v-model="form.visibleFields.businessUrl" type="checkbox" />
                  公开网址</small>
              </label>
            </div>

            <div class="editor-section">
              <div class="editor-heading">
                <div>
                  <span>03</span>
                  <h2>联系方式</h2>
                </div>
                <em>默认隐藏</em>
              </div>
              <p class="privacy-note">
                联系方式只在你单独勾选后出现在公开名片中，不会进入报名海报。
              </p>
              <div class="field-grid">
                <label class="field-block">
                  <span>联系电话</span>
                  <input
                    id="showcase-contact-phone"
                    v-model="form.contactPhone"
                    maxlength="40"
                    autocomplete="tel"
                  />
                  <small><input v-model="form.visibleFields.contactPhone" type="checkbox" />
                    公开电话</small>
                </label>
                <label
                  class="field-block"
                  :class="{ 'is-invalid': validationIssueFor('contactEmail') }"
                >
                  <span>联系邮箱</span>
                  <input
                    id="showcase-contact-email"
                    v-model="form.contactEmail"
                    type="email"
                    maxlength="255"
                    autocomplete="email"
                    :aria-invalid="Boolean(validationIssueFor('contactEmail'))"
                    :aria-describedby="
                      validationIssueFor('contactEmail')
                        ? 'showcase-contact-email-error'
                        : undefined
                    "
                  />
                  <span
                    v-if="validationIssueFor('contactEmail')"
                    id="showcase-contact-email-error"
                    class="field-error"
                  >
                    {{ validationIssueFor('contactEmail')?.message }}
                  </span>
                  <small><input v-model="form.visibleFields.contactEmail" type="checkbox" />
                    公开邮箱</small>
                </label>
                <label class="field-block">
                  <span>微信号</span>
                  <input id="showcase-wechat-id" v-model="form.wechatId" maxlength="80" />
                  <small><input v-model="form.visibleFields.wechatId" type="checkbox" />
                    公开微信号</small>
                </label>
              </div>
            </div>

            <div class="publish-choice">
              <label>
                <input id="showcase-is-public" v-model="form.isPublic" type="checkbox" />
                <span>
                  <strong>在大会主页展示我的参会名片</strong>
                  <small>开启即代表你同意按照当前字段授权对外展示，可随时关闭或修改。</small>
                </span>
              </label>
              <p v-if="profile.adminHidden" class="moderation-note">
                当前名片已由管理员下架：{{ profile.adminHiddenReason || '请联系大会组委会' }}
              </p>
              <p v-else-if="!form.isPublic" class="qualification-note">
                当前名片仅自己可见。填写姓名和主行业、开启主页展示并保存后，前台将在约 8
                秒内自动更新。头像上传成功且开启“对外展示”后显示照片，否则使用姓名文字头像。
              </p>
              <p v-else-if="form.isPublic && !profile.effectivePublic" class="qualification-note">
                保存后系统会重新校验展示资格。{{ profile.qualificationReason }}
              </p>
            </div>

            <p v-if="errorMessage" class="form-message is-error" role="alert">{{ errorMessage }}</p>
            <p v-if="successMessage" class="form-message is-success" role="status">
              {{ successMessage }}
            </p>
            <div class="editor-actions">
              <button type="submit" class="primary-action" :disabled="saving">
                {{ saving ? '正在保存…' : '保存并更新海报' }}
              </button>
              <NuxtLink class="secondary-action" :to="homeHref">返回大会首页</NuxtLink>
              <NuxtLink class="secondary-action" :to="accountHref">回到个人中心</NuxtLink>
              <NuxtLink v-if="attendeeNeedsEntryEnabled" class="secondary-action" :to="needsHref">
                继续填写参会需求
              </NuxtLink>
              <NuxtLink v-if="profile.invoiceAvailable" class="text-action" :to="invoiceHref">
                需要发票？去申请
              </NuxtLink>
            </div>
          </form>

          <aside class="poster-panel">
            <div class="poster-heading">
              <div>
                <span>PERSONAL POSTER</span>
                <h2>我的参会海报</h2>
              </div>
              <i>社交分享版 · 3:4</i>
            </div>
            <canvas ref="posterCanvas" width="1080" height="1440" aria-label="个人报名海报预览" />
            <div class="poster-actions">
              <button
                type="button"
                class="primary-action"
                :disabled="downloading"
                @click="downloadPoster"
              >
                {{ downloading ? '正在生成…' : '下载 1080 × 1440 海报' }}
              </button>
              <NuxtLink
                v-if="profile.effectivePublic && publicPreviewHref"
                class="secondary-action"
                :to="publicPreviewHref"
                target="_blank"
              >
                预览公开名片
              </NuxtLink>
            </div>
            <p>每次保存后，预览与下载内容都会基于最新资料重新生成。</p>
          </aside>
        </section>
      </template>
    </main>
    <div ref="qrHolder" class="qr-source" aria-hidden="true">
      <QRCode :value="showcaseUrl" :size="360" level="M" render-as="canvas" />
    </div>
  </div>
</template>

<style scoped>
.showcase-page {
  min-height: 100vh;
  background: #f4f7fb;
}
.showcase-shell {
  width: min(100% - 40px, 1240px);
  margin-inline: auto;
  padding: 58px 0 96px;
}
.showcase-intro {
  max-width: 780px;
  margin-bottom: 36px;
}
.showcase-intro h1 {
  margin: 10px 0 14px;
  color: #172033;
  font-size: clamp(34px, 5vw, 58px);
  line-height: 1.08;
  letter-spacing: -0.045em;
}
.showcase-intro > p:last-child {
  max-width: 700px;
  margin: 0;
  color: #687386;
  font-size: 16px;
  line-height: 1.8;
}
.showcase-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 390px;
  align-items: start;
  gap: 24px;
}
.showcase-stepper {
  margin-bottom: 28px;
}
.profile-editor,
.poster-panel {
  border: 1px solid #e1e7f0;
  background: #fff;
  box-shadow: 0 18px 50px rgb(31 48 78 / 7%);
}
.profile-editor {
  border-radius: 18px;
}
.editor-section {
  padding: 30px;
  border-bottom: 1px solid #e8edf4;
}
.editor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 24px;
}
.editor-heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.editor-heading span {
  color: #1f5fe8;
  font: 700 12px var(--conference-font-mono);
}
.editor-heading h2 {
  margin: 0;
  color: #172033;
  font-size: 20px;
  letter-spacing: -0.02em;
}
.editor-heading strong,
.editor-heading em {
  color: #667085;
  font-size: 12px;
  font-style: normal;
}
.avatar-row {
  display: grid;
  grid-template-columns: 92px 1fr auto;
  align-items: center;
  gap: 18px;
  margin-bottom: 28px;
  padding: 18px;
  background: #f7f9fc;
  border-radius: 12px;
}
.avatar-preview {
  display: grid;
  width: 92px;
  height: 92px;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: #e7efff;
  color: #1f5fe8;
  font-size: 24px;
  font-weight: 750;
}
.avatar-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-preview.is-processing {
  opacity: 0.58;
}
.upload-action {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  padding: 0 14px;
  border: 1px solid #ccd6e6;
  border-radius: 7px;
  color: #25324a;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.upload-action input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.avatar-row p,
.poster-panel > p {
  margin: 10px 0 0;
  color: #8490a3;
  font-size: 11px;
  line-height: 1.6;
}
.text-action {
  border: 0;
  background: transparent;
  color: #3166cf;
  font-size: 12px;
  cursor: pointer;
}
.avatar-row .text-action {
  margin-left: 8px;
}
.visibility-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #596579;
  font-size: 12px;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.field-block {
  display: grid;
  gap: 8px;
  color: #3d485a;
  font-size: 12px;
  font-weight: 650;
}
.field-block > span:first-child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.required-mark {
  color: #9a5a17;
  font-size: 10px;
  font-style: normal;
  font-weight: 650;
}
.field-block.is-wide {
  margin-top: 18px;
}
.field-block input:not([type='checkbox']),
.field-block select,
.field-block textarea {
  width: 100%;
  min-height: 46px;
  border: 1px solid #d6deea;
  border-radius: 8px;
  background: #fff;
  color: #172033;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  outline: none;
  padding: 0 13px;
  transition:
    border-color 140ms ease,
    box-shadow 140ms ease;
}
.field-block textarea {
  min-height: 132px;
  padding-block: 12px;
  resize: vertical;
  line-height: 1.65;
}
.field-block input:focus,
.field-block select:focus,
.field-block textarea:focus {
  border-color: #1f5fe8;
  box-shadow: 0 0 0 3px rgb(31 95 232 / 10%);
}
.field-block input[aria-invalid='true'],
.field-block select[aria-invalid='true'],
.field-block textarea[aria-invalid='true'] {
  border-color: #d84a64;
  background: #fffafb;
  box-shadow: 0 0 0 3px rgb(216 74 100 / 9%);
}
.field-error {
  color: #b4233c;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
}
.field-block small {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #788497;
  font-size: 11px;
  font-weight: 500;
}
.privacy-note {
  margin: -10px 0 20px;
  color: #758196;
  font-size: 12px;
}
.publish-choice {
  padding: 26px 30px;
  background: #f7faff;
  border-bottom: 1px solid #e8edf4;
}
.publish-choice > label {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}
.publish-choice input {
  margin-top: 4px;
}
.publish-choice span {
  display: grid;
  gap: 5px;
}
.publish-choice strong {
  color: #172033;
  font-size: 15px;
}
.publish-choice small {
  color: #6e7a8f;
  font-size: 12px;
  line-height: 1.6;
}
.moderation-note,
.qualification-note {
  margin: 14px 0 0 28px;
  color: #a1540f;
  font-size: 12px;
}
.editor-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px 30px;
  flex-wrap: wrap;
}
.primary-action,
.secondary-action {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  padding: 0 18px;
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 140ms ease,
    border-color 140ms ease;
}
.primary-action:active,
.secondary-action:active {
  transform: scale(0.97);
}
.primary-action {
  border: 1px solid #1f5fe8;
  background: #1f5fe8;
  color: #fff;
}
.primary-action:disabled {
  opacity: 0.55;
  cursor: wait;
}
.secondary-action {
  border: 1px solid #d6deea;
  background: #fff;
  color: #27344b;
}
.form-message {
  margin: 18px 30px 0;
  padding: 11px 13px;
  border-radius: 8px;
  font-size: 12px;
}
.form-message.is-error {
  background: #fff1f2;
  color: #b4233c;
}
.form-message.is-success {
  background: #edf9f2;
  color: #137148;
}
.poster-panel {
  position: sticky;
  top: 22px;
  border-radius: 18px;
  padding: 22px;
}
.poster-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.poster-heading span {
  color: #1f5fe8;
  font: 700 10px var(--conference-font-mono);
}
.poster-heading h2 {
  margin: 5px 0 0;
  color: #172033;
  font-size: 19px;
}
.poster-heading i {
  padding: 5px 7px;
  border-radius: 5px;
  background: #f0f4fa;
  color: #687386;
  font-size: 10px;
  font-style: normal;
}
.poster-panel canvas {
  display: block;
  width: 100%;
  height: auto;
  background: #07111f;
  box-shadow:
    0 18px 42px rgb(7 17 31 / 18%),
    0 0 0 1px rgb(7 17 31 / 8%);
}
.poster-actions {
  display: grid;
  gap: 9px;
  margin-top: 16px;
}
.showcase-state {
  padding: 70px 0;
  color: #6c778a;
  text-align: center;
}
.showcase-state.is-error {
  color: #b4233c;
}
.qr-source {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 360px;
  height: 360px;
  pointer-events: none;
}
@media (max-width: 960px) {
  .showcase-layout {
    grid-template-columns: 1fr;
  }
  .poster-panel {
    position: static;
    width: min(100%, 520px);
    margin-inline: auto;
  }
}
@media (max-width: 640px) {
  .showcase-shell {
    width: min(100% - 24px, 1240px);
    padding-top: 36px;
  }
  .editor-section,
  .publish-choice {
    padding: 22px 18px;
  }
  .field-grid {
    grid-template-columns: 1fr;
  }
  .avatar-row {
    grid-template-columns: 74px 1fr;
  }
  .avatar-preview {
    width: 74px;
    height: 74px;
  }
  .visibility-toggle {
    grid-column: 1 / -1;
  }
  .editor-actions {
    padding: 20px 18px;
  }
  .primary-action,
  .secondary-action {
    width: 100%;
  }
}
</style>
