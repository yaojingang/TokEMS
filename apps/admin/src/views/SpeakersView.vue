<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  isPublicEventStatus,
  speakerAvatarText,
  type AdminSpeakerSummary,
} from '@conference/contracts';
import { useRouter } from 'vue-router';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, publicEventUrl, session } from '../lib/api';

const router = useRouter();
const speakers = ref<AdminSpeakerSummary[]>([]);
const loading = ref(true);
const pending = ref(false);
const deleteTarget = ref<AdminSpeakerSummary>();
const message = ref('');
const errorMessage = ref('');

const publicEvent = computed(() => session.activeEvent.value);

function avatarInitial(speaker: AdminSpeakerSummary) {
  return speakerAvatarText(speaker.name, speaker.initials);
}

function profileScore(speaker: AdminSpeakerSummary) {
  const values = [
    speaker.avatarAssetId,
    speaker.bio,
    speaker.topicAbstract,
    speaker.websiteUrl,
    speaker.socialLinks.length ? 'links' : null,
  ];
  return Math.round((values.filter(Boolean).length / values.length) * 100);
}

function publicUrl(speaker: AdminSpeakerSummary) {
  if (!publicEvent.value || !isPublicEventStatus(publicEvent.value.status)) return;
  return publicEventUrl(`/speakers/${encodeURIComponent(speaker.id)}`);
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    speakers.value = await conferenceApi.getSpeakers();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '嘉宾资料读取失败';
  } finally {
    loading.value = false;
  }
}

async function move(index: number, offset: -1 | 1) {
  const targetIndex = index + offset;
  if (pending.value || targetIndex < 0 || targetIndex >= speakers.value.length) return;
  const previous = [...speakers.value];
  const reordered = [...speakers.value];
  const [speaker] = reordered.splice(index, 1);
  if (!speaker) return;
  reordered.splice(targetIndex, 0, speaker);
  speakers.value = reordered;
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    await conferenceApi.reorderSpeakers(reordered.map((item) => item.id));
    message.value = '嘉宾展示顺序已更新';
  } catch (error) {
    speakers.value = previous;
    errorMessage.value = error instanceof Error ? error.message : '嘉宾排序保存失败';
  } finally {
    pending.value = false;
  }
}

async function copyPublicUrl(speaker: AdminSpeakerSummary) {
  const url = publicUrl(speaker);
  if (!url) return;
  await navigator.clipboard.writeText(url);
  message.value = `已复制 ${speaker.name} 的公开页面地址`;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    await conferenceApi.deleteSpeaker(target.id);
    speakers.value = speakers.value.filter((item) => item.id !== target.id);
    deleteTarget.value = undefined;
    message.value = `已删除嘉宾“${target.name}”`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '嘉宾删除失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">SPEAKER DIRECTORY</p>
      <h1>嘉宾管理</h1>
      <p>维护嘉宾公开资料、演讲信息与首页展示顺序。</p>
    </div>
    <button class="button" type="button" @click="router.push({ name: 'event-speaker-create' })">
      ＋ 新建嘉宾
    </button>
  </header>

  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading" role="status">正在读取嘉宾资料…</div>

  <section v-else class="admin-panel speaker-list-panel reveal is-visible">
    <header class="admin-panel-header">
      <div>
        <h2>{{ speakers.length }} 位嘉宾</h2>
        <p>公开大会保存后立即更新首页卡片与嘉宾详情页。</p>
      </div>
    </header>

    <div v-if="speakers.length" class="data-table-wrap">
      <table class="data-table speaker-table">
        <thead>
          <tr>
            <th>顺序</th>
            <th>嘉宾</th>
            <th>演讲主题</th>
            <th>资料完整度</th>
            <th>公开页面</th>
            <th aria-label="操作"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(speaker, index) in speakers" :key="speaker.id">
            <td class="speaker-order">
              <span>{{ String(index + 1).padStart(2, '0') }}</span>
              <div class="speaker-order-actions">
                <button
                  type="button"
                  :disabled="pending || index === 0"
                  :aria-label="`${speaker.name} 上移`"
                  @click="move(index, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  :disabled="pending || index === speakers.length - 1"
                  :aria-label="`${speaker.name} 下移`"
                  @click="move(index, 1)"
                >
                  ↓
                </button>
              </div>
            </td>
            <td class="speaker-identity-cell">
              <div class="speaker-identity">
                <div class="speaker-avatar" :style="{ '--avatar-color': speaker.accentFrom }">
                  <img
                    v-if="speaker.avatarPreviewUrl"
                    :src="speaker.avatarPreviewUrl"
                    :alt="`${speaker.name}的头像`"
                    width="48"
                    height="48"
                    loading="lazy"
                  />
                  <span v-else aria-hidden="true">{{ avatarInitial(speaker) }}</span>
                </div>
                <div>
                  <strong>{{ speaker.name }}</strong>
                  <span>{{ speaker.role }}</span>
                </div>
              </div>
            </td>
            <td class="speaker-topic">{{ speaker.topic }}</td>
            <td class="speaker-completeness-cell">
              <div class="speaker-completeness">
                <span>{{ profileScore(speaker) }}%</span>
                <div aria-hidden="true">
                  <i :style="{ width: `${profileScore(speaker)}%` }"></i>
                </div>
              </div>
            </td>
            <td class="speaker-public-cell">
              <div v-if="publicUrl(speaker)" class="speaker-public-actions">
                <button type="button" @click="copyPublicUrl(speaker)">复制</button>
                <a
                  :href="publicUrl(speaker)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开
                </a>
              </div>
              <span v-else class="speaker-public-pending">上线后可用</span>
            </td>
            <td class="speaker-actions-cell">
              <div class="speaker-row-actions">
                <button
                  class="button secondary compact"
                  type="button"
                  @click="
                    router.push({
                      name: 'event-speaker-edit',
                      params: { speakerId: speaker.id },
                    })
                  "
                >
                  编辑
                </button>
                <button class="button danger compact" type="button" @click="deleteTarget = speaker">
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="speaker-empty">
      <span aria-hidden="true">◎</span>
      <h2>还没有嘉宾资料</h2>
      <p>创建第一位嘉宾后，首页会自动出现对应卡片与独立详情页。</p>
      <button class="button" type="button" @click="router.push({ name: 'event-speaker-create' })">
        新建嘉宾
      </button>
    </div>
  </section>

  <AdminConfirmDialog
    :open="Boolean(deleteTarget)"
    :event-name="publicEvent?.name"
    title="确认删除这位嘉宾？"
    description="公开大会会立即移除首页卡片和详情页，历史发布版本仍保留当时资料。"
    confirm-label="确认删除"
    tone="danger"
    :busy="pending"
    :error="errorMessage"
    :details="deleteTarget ? [{ label: '嘉宾', value: deleteTarget.name }] : []"
    @cancel="deleteTarget = undefined"
    @confirm="confirmDelete"
  />
</template>

<style scoped>
.speaker-list-panel {
  overflow: hidden;
}

.speaker-table th:first-child,
.speaker-table td:first-child {
  width: 72px;
}

.speaker-order,
.speaker-order-actions,
.speaker-public-actions,
.speaker-row-actions {
  display: flex;
  align-items: center;
}

.speaker-order {
  gap: 10px;
  color: var(--blue);
  font-family: var(--mono);
  font-weight: 700;
}

.speaker-order-actions,
.speaker-public-actions,
.speaker-row-actions {
  gap: 6px;
}

.speaker-order-actions button,
.speaker-public-actions button,
.speaker-public-actions a {
  display: inline-grid;
  min-width: 40px;
  min-height: 40px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  text-decoration: none;
}

.speaker-order-actions button:disabled {
  cursor: default;
  opacity: 0.28;
}

.speaker-order-actions button:focus-visible,
.speaker-public-actions button:focus-visible,
.speaker-public-actions a:focus-visible {
  border-radius: var(--radius-xs);
  outline: 3px solid rgb(31 95 232 / 18%);
  outline-offset: -2px;
}

.speaker-identity {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-width: 205px;
}

.speaker-avatar {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: color-mix(in srgb, var(--avatar-color, var(--blue)) 12%, white);
  color: var(--avatar-color, var(--blue));
  font-size: 17px;
  font-weight: 750;
  outline: 1px solid rgb(18 35 61 / 10%);
  outline-offset: -1px;
}

.speaker-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.speaker-identity strong,
.speaker-identity span {
  display: block;
}

.speaker-identity strong {
  color: var(--ink);
  font-size: 13px;
}

.speaker-identity span {
  max-width: 36ch;
  margin-top: 4px;
  color: var(--muted);
  line-height: 1.55;
}

.speaker-topic {
  min-width: 165px;
  max-width: 34ch;
  line-height: 1.65;
}

.speaker-public-pending {
  color: var(--muted);
  font-size: 11px;
}

.speaker-completeness {
  display: grid;
  grid-template-columns: 34px 72px;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 10px;
}

.speaker-completeness > div {
  height: 3px;
  overflow: hidden;
  background: var(--line);
}

.speaker-completeness i {
  display: block;
  height: 100%;
  background: var(--blue);
}

.speaker-empty {
  display: grid;
  justify-items: start;
  padding: 54px 42px 64px;
}

.speaker-empty > span {
  color: var(--blue);
  font-size: 26px;
}

.speaker-empty h2 {
  margin: 18px 0 7px;
  font-family: var(--serif);
  font-size: 24px;
  font-weight: 500;
}

.speaker-empty p {
  margin: 0 0 22px;
  color: var(--muted);
}

@media (hover: hover) {
  .speaker-order-actions button:not(:disabled):hover,
  .speaker-public-actions button:hover,
  .speaker-public-actions a:hover {
    background: var(--surface);
    color: var(--blue);
  }
}

.speaker-order-actions button:active,
.speaker-public-actions button:active,
.speaker-public-actions a:active {
  transform: scale(0.96);
}

@media (max-width: 720px) {
  .speaker-table {
    display: block;
    min-width: 0;
  }

  .speaker-table thead {
    display: none;
  }

  .speaker-table tbody {
    display: grid;
  }

  .speaker-table tr {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    padding: 12px 10px;
    border-bottom: 1px solid var(--line);
  }

  .speaker-table tbody tr:last-child {
    border-bottom: 0;
  }

  .speaker-table td {
    min-height: 0;
    padding: 6px 8px;
    border: 0;
  }

  .speaker-order {
    grid-row: 1 / 4;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .speaker-order-actions {
    gap: 0;
    margin-left: -8px;
  }

  .speaker-identity {
    min-width: 0;
  }

  .speaker-topic {
    min-width: 0;
    padding-top: 10px !important;
    color: var(--ink);
  }

  .speaker-topic::before {
    display: block;
    margin-bottom: 4px;
    color: var(--muted);
    content: '演讲主题';
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
  }

  .speaker-completeness-cell,
  .speaker-public-cell {
    display: none;
  }

  .speaker-actions-cell {
    grid-column: 2;
  }

  .speaker-row-actions {
    justify-content: flex-end;
  }

  .speaker-empty {
    padding: 38px 24px 46px;
  }
}
</style>
