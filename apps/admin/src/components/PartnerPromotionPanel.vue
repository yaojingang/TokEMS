<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AdminPartnerPromotionView, PublicEvent } from '@conference/contracts';
import QRCode from 'qrcode.vue';
import {
  partnerPosterFilename,
  renderPersonalEventPoster,
  resolvePartnerPosterContent,
  resolvePartnerPosterCopy,
  resolvePartnerPosterOptions,
} from '@conference/ui/posters';
import { conferenceApi, publicPartnerReferralUrl } from '../lib/api';

const props = defineProps<{
  partnerId: string;
  eventId: number;
  version: number;
  unsaved: boolean;
}>();
const material = ref<AdminPartnerPromotionView | null>(null);
const busy = ref(false);
const rendering = ref(false);
const acting = ref(false);
const ready = ref(false);
const error = ref('');
const notice = ref('');
const qrHolder = ref<HTMLElement>();
const poster = ref<HTMLCanvasElement>();
const url = computed(() => publicPartnerReferralUrl(material.value?.referralPath ?? ''));
const available = computed(() =>
  Boolean(url.value && material.value && material.value.availability !== 'unavailable'),
);
let revision = 0;
let avatarUrl: string | undefined;
let avatarRequest: AbortController | undefined;
function releaseAvatar() {
  if (avatarUrl) URL.revokeObjectURL(avatarUrl);
  avatarUrl = undefined;
}

type MaterialSnapshot = { data: AdminPartnerPromotionView; current: number };

async function readMaterial(): Promise<MaterialSnapshot | null> {
  const current = ++revision;
  avatarRequest?.abort();
  busy.value = true;
  rendering.value = false;
  ready.value = false;
  material.value = null;
  error.value = '';
  notice.value = '';
  releaseAvatar();
  try {
    const data = await conferenceApi.getPartnerPromotion(props.partnerId, props.eventId);
    if (current !== revision) return null;
    material.value = data;
    return available.value ? { data, current } : null;
  } catch (failure) {
    if (current === revision)
      error.value = failure instanceof Error ? failure.message : '推广素材读取失败，请重试。';
    return null;
  } finally {
    if (current === revision) busy.value = false;
  }
}

async function renderMaterial({ data, current }: MaterialSnapshot) {
  if (current !== revision) return false;
  rendering.value = true;
  const request = new AbortController();
  avatarRequest = request;
  let nextAvatar: string | undefined;
  try {
    const event: PublicEvent | null = await conferenceApi
      .getEvent(data.eventSlug, props.eventId)
      .catch(() => null);
    if (current !== revision) return false;
    if (data.profile.avatarUrl) {
      const blob = await conferenceApi.getPartnerPromotionAvatar(
        data.id,
        data.profile.version,
        data.eventId,
        request.signal,
      );
      if (current !== revision) return false;
      nextAvatar = URL.createObjectURL(blob);
      // Verify the authenticated image before rendering so an incomplete avatar cannot produce a downloadable poster.
      const image = new Image();
      image.src = nextAvatar;
      await image.decode();
    }
    if (current !== revision) return false;
    const profile = {
      ...data.profile,
      posterCopy: resolvePartnerPosterCopy(data.profile),
      avatarUrl: nextAvatar ?? null,
    };
    await nextTick();
    const qr = qrHolder.value?.querySelector('canvas');
    if (current !== revision || !qr || !poster.value) return false;
    const rendered = await renderPersonalEventPoster(
      poster.value,
      qr,
      resolvePartnerPosterOptions(data, resolvePartnerPosterContent(profile), event),
    );
    if (current !== revision || !rendered) return false;
    avatarUrl = nextAvatar;
    ready.value = true;
    return true;
  } catch (failure) {
    if (current === revision)
      error.value = failure instanceof Error ? failure.message : '海报生成失败，请重试。';
    return false;
  } finally {
    if (nextAvatar && nextAvatar !== avatarUrl) URL.revokeObjectURL(nextAvatar);
    if (current === revision) rendering.value = false;
  }
}

async function refresh() {
  const snapshot = await readMaterial();
  if (snapshot) await renderMaterial(snapshot);
}

async function exportMaterial(kind: 'link' | 'qr' | 'poster') {
  if (acting.value || props.unsaved) return;
  acting.value = true;
  let current = revision;
  try {
    const snapshot = await readMaterial();
    if (!snapshot || props.unsaved) return;
    current = snapshot.current;
    const renderingPoster = renderMaterial(snapshot);
    if (kind === 'poster' && !(await renderingPoster)) return;
    await nextTick();
    if (current !== revision || !available.value || props.unsaved) return;
    if (kind === 'link') {
      if (!navigator.clipboard?.writeText)
        throw new Error('浏览器未允许自动复制，请选中上方链接手动复制。');
      await navigator.clipboard.writeText(url.value);
      if (current === revision) notice.value = '分销链接已复制。';
      return;
    }
    let canvas = poster.value;
    if (kind === 'qr') {
      const source = qrHolder.value?.querySelector('canvas');
      if (!source) throw new Error('二维码生成失败，请重试。');
      canvas = document.createElement('canvas');
      canvas.width = source.width + 80;
      canvas.height = source.height + 80;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器暂不支持二维码下载。');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 40, 40);
    } else if (!ready.value) return;
    if (!canvas) return;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas!.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('图片导出失败，请重试。'))),
        'image/png',
      ),
    );
    if (current !== revision || props.unsaved) return;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    const filename = partnerPosterFilename(
      resolvePartnerPosterContent(snapshot.data.profile).displayName,
      snapshot.data.eventName,
    );
    anchor.download =
      kind === 'poster' ? filename : filename.replace('推广海报.png', '分销二维码.png');
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    notice.value = kind === 'poster' ? '分销海报下载已开始。' : '分销二维码下载已开始。';
  } catch (failure) {
    if (current === revision)
      error.value =
        kind === 'link'
          ? '链接复制失败，请选中上方链接手动复制。'
          : failure instanceof Error
            ? failure.message
            : '下载失败，请重试。';
  } finally {
    acting.value = false;
  }
}

watch(
  () => [props.partnerId, props.eventId, props.version],
  () => {
    material.value = null;
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++revision;
  avatarRequest?.abort();
  material.value = null;
  releaseAvatar();
});
</script>

<template>
  <section class="partner-promotion" aria-label="合作伙伴推广素材" :aria-busy="busy || rendering">
    <div class="material-heading">
      <div>
        <h3>{{ material?.eventName || '推广素材' }}</h3>
        <p>{{ material?.profile.displayName || '大会合作伙伴' }}</p>
      </div>
      <button
        class="button secondary compact"
        type="button"
        :disabled="busy || acting"
        @click="refresh"
      >
        刷新素材
      </button>
    </div>
    <p v-if="material" class="material-status" :class="material.availability" role="status">
      {{ material.reason }}
    </p>
    <p v-if="unsaved" class="material-status pending_confirmation" role="status">
      资料尚未保存，请先保存修改后领取最新素材。
    </p>
    <p v-if="notice" class="material-message" role="status">{{ notice }}</p>
    <div v-if="error" class="material-error" role="alert">
      <p>{{ error }}</p>
      <button
        class="button secondary compact"
        type="button"
        :disabled="busy || acting"
        @click="refresh"
      >
        重新加载素材
      </button>
    </div>
    <div class="material-layout">
      <div class="material-details">
        <label class="material-link">专属分销链接<input
          :value="url"
          readonly
          aria-label="专属分销链接"
          placeholder="正在读取链接…"
          @focus="($event.target as HTMLInputElement).select()"
        /></label>
        <button
          class="button"
          type="button"
          :disabled="!available || busy || acting || unsaved"
          @click="exportMaterial('link')"
        >
          复制分销链接
        </button>
        <h4>分销二维码</h4>
        <div v-show="available" ref="qrHolder" class="material-qr">
          <QRCode v-if="url" :value="url" :size="360" level="M" render-as="canvas" />
        </div>
        <button
          class="button secondary"
          type="button"
          :disabled="!available || busy || acting || unsaved"
          @click="exportMaterial('qr')"
        >
          下载二维码 PNG
        </button>
        <p class="material-hint">
          二维码与海报使用同一分销链接。仅查看、复制和下载不会计入推广访问。
        </p>
      </div>
      <figure class="material-poster">
        <figcaption>分销海报 · 1080 × 1440</figcaption>
        <canvas
          v-show="ready && !busy && !rendering"
          ref="poster"
          width="1080"
          height="1440"
          aria-label="合作伙伴分销海报预览"
        />
        <p v-if="!ready || busy || rendering" class="material-placeholder" role="status">
          {{
            busy || rendering
              ? '正在生成推广素材…'
              : available
                ? '海报尚未生成，请刷新素材重试。'
                : '当前推广素材不可使用'
          }}
        </p>
        <button
          class="button"
          type="button"
          :disabled="!available || !ready || busy || rendering || acting || unsaved"
          @click="exportMaterial('poster')"
        >
          下载分销海报 PNG
        </button>
        <p class="material-hint">与合作伙伴本人登录后的已保存海报保持一致。</p>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.partner-promotion {
  padding: 22px 30px;
  overflow: auto;
  min-height: 0;
  color: #17385e;
}
.material-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.material-heading h3 {
  margin: 0 0 6px;
  font-size: 18px;
}
.material-heading p {
  margin: 0;
  color: #68788b;
  font-size: 13px;
}
.material-status,
.material-error {
  padding: 12px 14px;
  border: 1px solid #dbe5f0;
  border-radius: 10px;
  background: #f7f9fc;
  font-size: 13px;
  line-height: 1.7;
}
.material-status.ready,
.material-message {
  color: #166534;
}
.material-status.pending_confirmation {
  background: #fffbeb;
  border-color: #f2d99b;
  color: #8b5c15;
}
.material-status.unavailable,
.material-error {
  color: #9b2222;
  background: #fff1f1;
  border-color: #f0a6a6;
}
.material-error p {
  margin: 0 0 10px;
}
.material-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
  gap: 28px;
  margin-top: 20px;
}
.material-details {
  min-width: 0;
}
.material-link {
  display: grid;
  gap: 8px;
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 12px;
}
.material-link input {
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  border: 1px solid #ccd7e5;
  border-radius: 10px;
  background: #f7f9fc;
  color: #17385e;
  font:
    12px/1.7 ui-monospace,
    monospace;
}
.material-details h4 {
  margin: 28px 0 12px;
  font-size: 14px;
}
.material-qr {
  box-sizing: content-box;
  width: 164px;
  padding: 18px;
  margin-bottom: 14px;
  background: #fff;
  border: 1px solid #dbe5f0;
  border-radius: 10px;
}
.material-qr :deep(canvas) {
  display: block;
  width: 164px !important;
  height: 164px !important;
}
.material-poster {
  margin: 0;
  min-width: 0;
}
.material-poster figcaption {
  margin-bottom: 12px;
  color: #526176;
  font-size: 13px;
  font-weight: 650;
}
.material-poster > canvas {
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: 16px;
  border-radius: 10px;
}
.material-placeholder {
  display: grid;
  min-height: 260px;
  place-items: center;
  margin: 0 0 16px;
  padding: 20px;
  background: #f5f8fc;
  border: 1px solid #dbe5f0;
  border-radius: 10px;
  color: #68788b;
  font-size: 13px;
}
.material-hint {
  font-size: 12px;
  color: #68788b;
  line-height: 1.7;
}
.button:active {
  transform: translateY(1px);
}
.button:focus-visible {
  outline: 2px solid #2463a5;
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .partner-promotion {
    padding: 20px;
  }
  .material-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .material-poster {
    max-width: 360px;
  }
  .material-heading {
    flex-wrap: wrap;
  }
}
</style>
