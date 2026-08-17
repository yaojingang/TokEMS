<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  isPublicEventStatus,
  speakerAvatarText,
  type CreateSpeaker,
  type SpeakerSocialLink,
} from '@conference/contracts';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, publicEventUrl, session } from '../lib/api';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const pending = ref(false);
const uploading = ref(false);
const message = ref('');
const errorMessage = ref('');
const avatarPreviewUrl = ref<string | null>(null);
const savedSnapshot = ref('');
const speakerId = computed(() =>
  route.name === 'event-speaker-edit' ? String(route.params.speakerId ?? '') : '',
);
const isNew = computed(() => !speakerId.value);

const form = reactive({
  name: '',
  role: '',
  topic: '',
  initials: '',
  accentFrom: '#2448a8',
  accentTo: '#102759',
  tags: '',
  avatarAssetId: null as string | null,
  bio: '',
  topicAbstract: '',
  websiteUrl: '',
  socialLinks: [] as SpeakerSocialLink[],
  sortOrder: 0,
});

const currentSnapshot = computed(() => JSON.stringify(form));
const dirty = computed(
  () => Boolean(savedSnapshot.value) && currentSnapshot.value !== savedSnapshot.value,
);
const avatarInitial = computed(() => speakerAvatarText(form.name, form.initials));
const publicUrl = computed(() =>
  speakerId.value &&
  session.activeEvent.value &&
  isPublicEventStatus(session.activeEvent.value.status)
    ? publicEventUrl(`/speakers/${encodeURIComponent(speakerId.value)}`)
    : undefined,
);

function applySavedSnapshot() {
  savedSnapshot.value = currentSnapshot.value;
}

function tags() {
  return [
    ...new Set(
      form.tags
        .split(/[、，,；;\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isPublicUrl(value: string) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function preparedInput(): CreateSpeaker | undefined {
  message.value = '';
  errorMessage.value = '';
  if (!form.name.trim() || !form.role.trim() || !form.topic.trim()) {
    errorMessage.value = '请完整填写嘉宾姓名、职务与机构、演讲主题';
    return;
  }
  const preparedLinks = form.socialLinks
    .map((item) => ({ label: item.label.trim(), url: item.url.trim() }))
    .filter((item) => item.label || item.url);
  if (preparedLinks.some((item) => !item.label || !item.url)) {
    errorMessage.value = '公开链接需要同时填写名称和网址';
    return;
  }
  if (
    (form.websiteUrl.trim() && !isPublicUrl(form.websiteUrl.trim())) ||
    preparedLinks.some((item) => !isPublicUrl(item.url))
  ) {
    errorMessage.value = '官网和公开链接需要使用有效的 HTTP 或 HTTPS 地址';
    return;
  }
  if (preparedLinks.length > 6) {
    errorMessage.value = '公开链接最多添加 6 条';
    return;
  }
  if (tags().length > 12) {
    errorMessage.value = '嘉宾标签最多填写 12 个';
    return;
  }
  return {
    name: form.name.trim(),
    role: form.role.trim(),
    topic: form.topic.trim(),
    initials: form.initials.trim() || avatarInitial.value,
    accentFrom: form.accentFrom,
    accentTo: form.accentTo,
    tags: tags(),
    avatarAssetId: form.avatarAssetId,
    bio: form.bio.trim() || null,
    topicAbstract: form.topicAbstract.trim() || null,
    websiteUrl: form.websiteUrl.trim() || null,
    socialLinks: preparedLinks,
    sortOrder: form.sortOrder,
  };
}

async function load() {
  if (isNew.value) {
    applySavedSnapshot();
    return;
  }
  loading.value = true;
  errorMessage.value = '';
  try {
    const speaker = await conferenceApi.getSpeaker(speakerId.value);
    form.name = speaker.name;
    form.role = speaker.role;
    form.topic = speaker.topic;
    form.initials =
      speaker.initials === speakerAvatarText(speaker.name) ? '' : speaker.initials;
    form.accentFrom = speaker.accentFrom;
    form.accentTo = speaker.accentTo;
    form.tags = speaker.tags.join('、');
    form.avatarAssetId = speaker.avatarAssetId;
    form.bio = speaker.bio ?? '';
    form.topicAbstract = speaker.topicAbstract ?? '';
    form.websiteUrl = speaker.websiteUrl ?? '';
    form.socialLinks = speaker.socialLinks.map((item) => ({ ...item }));
    form.sortOrder = speaker.sortOrder;
    avatarPreviewUrl.value = speaker.avatarPreviewUrl;
    applySavedSnapshot();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '嘉宾资料读取失败';
  } finally {
    loading.value = false;
  }
}

function readImageDimensions(file: File) {
  return new Promise<{ width: number; height: number } | undefined>((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve(undefined);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

async function uploadAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    errorMessage.value = '头像仅支持 JPG、PNG 或 WebP 图片';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    errorMessage.value = '头像文件不能超过 10MB';
    return;
  }
  uploading.value = true;
  errorMessage.value = '';
  try {
    const dimensions = await readImageDimensions(file);
    const asset = await conferenceApi.uploadSpeakerImage(
      file,
      `${form.name.trim() || '嘉宾'}的头像`,
      dimensions,
    );
    form.avatarAssetId = asset.id;
    avatarPreviewUrl.value = asset.previewUrl;
    message.value = '头像已上传，请保存嘉宾资料使其生效';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '头像上传失败';
  } finally {
    uploading.value = false;
  }
}

function removeAvatar() {
  form.avatarAssetId = null;
  avatarPreviewUrl.value = null;
  message.value = '头像引用已移除，请保存嘉宾资料使其生效';
}

function addSocialLink() {
  if (form.socialLinks.length >= 6) return;
  form.socialLinks.push({ label: '', url: '' });
}

async function save() {
  const input = preparedInput();
  if (!input) return;
  pending.value = true;
  try {
    const saved = isNew.value
      ? await conferenceApi.createSpeaker(input)
      : await conferenceApi.updateSpeaker(speakerId.value, input);
    form.sortOrder = saved.sortOrder;
    avatarPreviewUrl.value = saved.avatarPreviewUrl;
    applySavedSnapshot();
    message.value =
      session.activeEvent.value && isPublicEventStatus(session.activeEvent.value.status)
      ? '已保存，嘉宾首页卡片与详情页已更新'
      : '已保存，大会上线时公开';
    if (isNew.value) {
      await router.replace({
        name: 'event-speaker-edit',
        params: { speakerId: saved.id },
      });
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '嘉宾资料保存失败';
  } finally {
    pending.value = false;
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return window.confirm('嘉宾资料尚未保存，确认离开当前页面？');
});

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload);
  void load();
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload));
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">SPEAKER PROFILE</p>
      <h1>{{ isNew ? '新建嘉宾' : '编辑嘉宾资料' }}</h1>
      <p>公开页面只展示职业信息与官方链接。</p>
    </div>
    <div class="admin-head-actions">
      <button
        class="button secondary"
        type="button"
        @click="router.push({ name: 'event-speakers' })"
      >
        返回列表
      </button>
      <a
        v-if="publicUrl"
        class="button secondary"
        :href="publicUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        查看公开页
      </a>
      <button class="button" type="button" :disabled="pending || loading" @click="save">
        {{ pending ? '保存中…' : '保存资料' }}
      </button>
    </div>
  </header>

  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading" role="status">正在读取嘉宾资料…</div>

  <div v-else class="speaker-editor-layout">
    <form class="speaker-editor-main" @submit.prevent="save">
      <section class="admin-panel">
        <header class="admin-panel-header">
          <div>
            <h2>基本资料</h2>
            <p>姓名、职务与机构、演讲主题会同时出现在首页卡片和详情页。</p>
          </div>
        </header>
        <div class="event-form speaker-form-section">
          <div class="form-grid">
            <div class="form-field">
              <label for="speaker-name">姓名</label>
              <input id="speaker-name" v-model="form.name" maxlength="120" required />
            </div>
            <div class="form-field">
              <label for="speaker-initials">文字头像</label>
              <input
                id="speaker-initials"
                v-model="form.initials"
                maxlength="8"
                :placeholder="avatarInitial"
              />
              <small>留空时自动使用姓名的第一个字符。</small>
            </div>
            <div class="form-field full">
              <label for="speaker-role">职务与机构</label>
              <input id="speaker-role" v-model="form.role" maxlength="240" required />
            </div>
            <div class="form-field full">
              <label for="speaker-topic">演讲主题</label>
              <input id="speaker-topic" v-model="form.topic" maxlength="240" required />
            </div>
            <div class="form-field full">
              <label for="speaker-tags">标签</label>
              <input id="speaker-tags" v-model="form.tags" placeholder="品牌心智、GEO方法论" />
              <small>使用逗号或顿号分隔，最多 12 个。</small>
            </div>
          </div>
        </div>
      </section>

      <section class="admin-panel">
        <header class="admin-panel-header">
          <div>
            <h2>职业档案与演讲内容</h2>
            <p>详情页会自动隐藏没有填写的内容区块。</p>
          </div>
        </header>
        <div class="event-form speaker-form-section">
          <div class="form-grid">
            <div class="form-field full">
              <label for="speaker-bio">个人简介</label>
              <textarea id="speaker-bio" v-model="form.bio" maxlength="5000" rows="7"></textarea>
              <small>{{ form.bio.length }} / 5000</small>
            </div>
            <div class="form-field full">
              <label for="speaker-topic-abstract">演讲摘要</label>
              <textarea
                id="speaker-topic-abstract"
                v-model="form.topicAbstract"
                maxlength="5000"
                rows="7"
              ></textarea>
              <small>{{ form.topicAbstract.length }} / 5000</small>
            </div>
          </div>
        </div>
      </section>

      <section class="admin-panel">
        <header class="admin-panel-header">
          <div>
            <h2>公开链接</h2>
            <p>只填写官网和公开社交主页，不展示私人联系方式。</p>
          </div>
          <button
            class="button secondary compact"
            type="button"
            :disabled="form.socialLinks.length >= 6"
            @click="addSocialLink"
          >
            ＋ 添加链接
          </button>
        </header>
        <div class="event-form speaker-form-section">
          <div class="form-field">
            <label for="speaker-website">官方网站</label>
            <input
              id="speaker-website"
              v-model="form.websiteUrl"
              type="url"
              maxlength="500"
              placeholder="https://"
            />
          </div>
          <div class="speaker-link-list">
            <div v-for="(link, index) in form.socialLinks" :key="index" class="speaker-link-row">
              <div class="form-field">
                <label :for="`speaker-link-label-${index}`">链接名称</label>
                <input
                  :id="`speaker-link-label-${index}`"
                  v-model="link.label"
                  maxlength="40"
                  placeholder="LinkedIn"
                />
              </div>
              <div class="form-field">
                <label :for="`speaker-link-url-${index}`">公开网址</label>
                <input
                  :id="`speaker-link-url-${index}`"
                  v-model="link.url"
                  type="url"
                  maxlength="500"
                  placeholder="https://"
                />
              </div>
              <button
                type="button"
                :aria-label="`删除第 ${index + 1} 条公开链接`"
                @click="form.socialLinks.splice(index, 1)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      </section>

      <div class="speaker-save-bar">
        <span>{{ dirty ? '有未保存修改' : '资料已同步' }}</span>
        <button class="button" type="submit" :disabled="pending">
          {{ pending ? '保存中…' : '保存资料' }}
        </button>
      </div>
    </form>

    <aside class="speaker-editor-aside">
      <section class="admin-panel speaker-avatar-panel">
        <p class="eyebrow">PUBLIC PORTRAIT</p>
        <div class="speaker-avatar-preview" :style="{ '--avatar-color': form.accentFrom }">
          <img
            v-if="avatarPreviewUrl"
            :src="avatarPreviewUrl"
            :alt="`${form.name || '嘉宾'}的头像预览`"
            width="176"
            height="176"
          />
          <span v-else aria-hidden="true">{{ avatarInitial }}</span>
        </div>
        <div class="speaker-avatar-actions">
          <label class="button secondary" :class="{ disabled: uploading }">
            {{ uploading ? '上传中…' : '上传头像' }}
            <input
              class="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              :disabled="uploading"
              @change="uploadAvatar"
            />
          </label>
          <button
            v-if="avatarPreviewUrl"
            class="button secondary"
            type="button"
            @click="removeAvatar"
          >
            移除头像
          </button>
        </div>
        <p>支持 JPG、PNG、WebP，单张不超过 10MB。推荐使用正方形或半身职业照。</p>
      </section>

      <section class="speaker-public-preview">
        <div class="speaker-preview-meta"><span>SPEAKER</span><span>PROFILE</span></div>
        <h2>{{ form.name || '嘉宾姓名' }}</h2>
        <p>{{ form.role || '职务与机构' }}</p>
        <div class="speaker-preview-rule"></div>
        <strong>{{ form.topic || '演讲主题' }}</strong>
        <div v-if="tags().length" class="speaker-preview-tags">
          <span v-for="tag in tags()" :key="tag">{{ tag }}</span>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.speaker-editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  align-items: start;
  gap: 18px;
}

.speaker-editor-main {
  display: grid;
  gap: 18px;
}

.speaker-form-section {
  padding: 22px;
}

.speaker-form-section textarea {
  min-height: 150px;
}

.speaker-link-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.speaker-link-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) 40px;
  align-items: end;
  gap: 10px;
  padding: 12px;
  background: var(--surface);
  border-top: 1px solid var(--line);
}

.speaker-link-row > button {
  width: 40px;
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--red);
  cursor: pointer;
  font-size: 20px;
}

.speaker-link-row > button:focus-visible {
  border-radius: var(--radius-xs);
  outline: 3px solid rgb(208 49 65 / 16%);
}

.speaker-save-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--line-strong);
  box-shadow: 0 8px 20px rgb(18 35 61 / 6%);
}

.speaker-save-bar span {
  color: var(--muted);
  font-size: 11px;
}

.speaker-editor-aside {
  position: sticky;
  top: 20px;
  display: grid;
  gap: 14px;
}

.speaker-avatar-panel {
  display: grid;
  justify-items: start;
  padding: 22px;
}

.speaker-avatar-preview {
  display: grid;
  width: 176px;
  height: 176px;
  margin: 18px auto 20px;
  place-self: center;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: color-mix(in srgb, var(--avatar-color, var(--blue)) 12%, white);
  color: var(--avatar-color, var(--blue));
  font-family: var(--serif);
  font-size: 54px;
  outline: 1px solid rgb(18 35 61 / 12%);
  outline-offset: -1px;
}

.speaker-avatar-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.speaker-avatar-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
}

.speaker-avatar-actions .button {
  width: 100%;
  cursor: pointer;
}

.speaker-avatar-actions .disabled {
  cursor: wait;
  opacity: 0.58;
}

.speaker-avatar-panel > p:last-child {
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.7;
}

.speaker-public-preview {
  padding: 24px;
  background: #fff;
  border: 1px solid var(--line-strong);
}

.speaker-preview-meta {
  display: flex;
  justify-content: space-between;
  color: var(--blue);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.speaker-public-preview h2 {
  margin: 30px 0 8px;
  font-family: var(--serif);
  font-size: 29px;
  font-weight: 500;
  line-height: 1.18;
  overflow-wrap: anywhere;
}

.speaker-public-preview > p {
  min-height: 42px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.65;
}

.speaker-preview-rule {
  height: 1px;
  margin: 22px 0;
  background: var(--line);
}

.speaker-public-preview > strong {
  display: block;
  font-size: 14px;
  line-height: 1.65;
}

.speaker-preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 18px;
}

.speaker-preview-tags span {
  padding: 5px 9px;
  background: var(--blue-soft);
  color: var(--blue);
  border-radius: var(--radius-pill);
  font-size: 10px;
}

@media (max-width: 980px) {
  .speaker-editor-layout {
    grid-template-columns: 1fr;
  }

  .speaker-editor-aside {
    position: static;
    grid-template-columns: minmax(260px, 0.65fr) 1fr;
  }
}

@media (max-width: 680px) {
  .speaker-editor-aside {
    grid-template-columns: 1fr;
  }

  .speaker-link-row {
    grid-template-columns: 1fr 40px;
  }

  .speaker-link-row .form-field:first-child {
    grid-column: 1 / -1;
  }

  .speaker-save-bar {
    bottom: 10px;
  }
}
</style>
