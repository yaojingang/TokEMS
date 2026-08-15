<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { AccountProfile, UpdateAccountProfile } from '@conference/contracts';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import { organizationRoleLabel } from '../lib/roles';

const route = useRoute();
const account = ref<AccountProfile>();
const loading = ref(true);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const mobileError = ref('');
const savedSnapshot = ref('');
const form = reactive({
  name: '',
  email: '',
  username: '',
  mobile: '',
  company: '',
  title: '',
  city: '',
  bio: '',
  tags: '',
});

function tagsFromText(value: string) {
  return value
    .split(/、|,|，/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function payload(): UpdateAccountProfile {
  return {
    name: form.name.trim(),
    mobile: form.mobile.trim() || null,
    profile: {
      company: form.company.trim() || null,
      title: form.title.trim() || null,
      city: form.city.trim() || null,
      bio: form.bio.trim() || null,
      tags: tagsFromText(form.tags),
    },
  };
}

const dirty = computed(
  () => Boolean(savedSnapshot.value) && JSON.stringify(payload()) !== savedSnapshot.value,
);
const roleLabel = computed(() => organizationRoleLabel(account.value?.membership.role));
const accountInitial = computed(() => form.name.trim().charAt(0) || '管');
const loginIdentifier = computed(() => form.username || form.email);
const permissionSummary = computed(() => {
  const grants = account.value?.membership.grants ?? [];
  return grants.includes('*') ? '完整管理权限' : `${grants.length} 项授权`;
});
const returnRoute = computed(() => {
  const raw = Array.isArray(route.query.from) ? route.query.from[0] : route.query.from;
  if (
    typeof raw === 'string' &&
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !raw.startsWith('/account')
  ) {
    return raw;
  }
  return { name: session.landingRouteName() };
});

function fill(value: AccountProfile) {
  account.value = value;
  Object.assign(form, {
    name: value.user.name,
    email: value.user.email ?? '',
    username: value.user.username ?? '',
    mobile: value.user.mobile ?? '',
    company: value.profile?.company ?? '',
    title: value.profile?.title ?? '',
    city: value.profile?.city ?? '',
    bio: value.profile?.bio ?? '',
    tags: value.profile?.tags.join('、') ?? '',
  });
  savedSnapshot.value = JSON.stringify(payload());
  session.syncAccountProfile(value);
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    fill(await conferenceApi.getAccountProfile());
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '个人资料读取失败';
  } finally {
    loading.value = false;
  }
}

async function save() {
  message.value = '';
  errorMessage.value = '';
  mobileError.value = '';
  const input = payload();
  if (!input.name) {
    errorMessage.value = '请填写姓名';
    return;
  }
  if (input.mobile && input.mobile.length < 7) {
    mobileError.value = '手机号至少需要 7 个字符';
    return;
  }
  if (input.profile.tags.length > 30) {
    errorMessage.value = '标签最多填写 30 个';
    return;
  }

  pending.value = true;
  try {
    fill(await conferenceApi.updateAccountProfile(input));
    message.value = '个人资料已保存';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '个人资料保存失败';
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
  return window.confirm('个人资料还有未保存的修改，确认离开当前页面？');
});

onMounted(() => {
  void load();
  window.addEventListener('beforeunload', handleBeforeUnload);
});
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload));
</script>

<template>
  <header class="admin-page-head account-page-head reveal is-visible">
    <div>
      <p class="eyebrow">PERSONAL ACCOUNT</p>
      <h1>个人中心</h1>
      <p>维护你的个人资料，并确认当前组织中的角色与访问范围。</p>
    </div>
    <RouterLink class="button secondary" :to="returnRoute">← 返回原工作台</RouterLink>
  </header>

  <p v-if="message" class="admin-success" role="status">{{ message }}</p>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <div v-if="loading" class="admin-loading">正在载入个人资料…</div>

  <template v-else-if="account">
    <section class="account-identity-strip" aria-label="当前账号概览">
      <span class="account-identity-avatar" aria-hidden="true">{{ accountInitial }}</span>
      <div class="account-identity-copy">
        <p>当前登录身份</p>
        <h2>{{ form.name }}</h2>
        <span>{{ loginIdentifier }}</span>
      </div>
      <dl class="account-identity-facts">
        <div>
          <dt>用户 ID</dt>
          <dd>{{ account.user.id }}</dd>
        </div>
        <div>
          <dt>所属组织</dt>
          <dd>{{ account.organization.name }}</dd>
        </div>
        <div>
          <dt>当前角色</dt>
          <dd>{{ roleLabel }}</dd>
        </div>
        <div>
          <dt>账号状态</dt>
          <dd class="account-status-active">已启用</dd>
        </div>
      </dl>
    </section>

    <div class="account-content-grid">
      <section class="admin-panel account-profile-panel">
        <header class="admin-panel-header">
          <div>
            <h2>个人资料</h2>
            <p>这些信息用于大会协作、成员识别和内部联络。</p>
          </div>
          <span v-if="dirty" class="status-badge draft">尚未保存</span>
        </header>
        <form
          class="event-form settings-form-spaced"
          aria-label="个人资料表单"
          @submit.prevent="save"
        >
          <div class="form-grid">
            <div class="form-field">
              <label for="account-name">姓名</label>
              <input
                id="account-name"
                v-model="form.name"
                required
                maxlength="120"
                autocomplete="name"
              />
            </div>
            <div class="form-field">
              <label for="account-login-identifier">
                {{ form.username ? '登录用户名' : '登录邮箱' }}
              </label>
              <input
                id="account-login-identifier"
                :value="loginIdentifier"
                class="account-readonly-input"
                :type="form.username ? 'text' : 'email'"
                readonly
                aria-describedby="account-login-identifier-help"
              />
              <small id="account-login-identifier-help">
                登录凭据变更需要身份验证，请联系组织管理员。
              </small>
            </div>
            <div class="form-field">
              <label for="account-mobile">手机号</label>
              <input
                id="account-mobile"
                v-model="form.mobile"
                maxlength="32"
                autocomplete="tel"
                inputmode="tel"
                :aria-invalid="Boolean(mobileError)"
                :aria-describedby="mobileError ? 'account-mobile-error' : undefined"
              />
              <small v-if="mobileError" id="account-mobile-error" class="field-error" role="alert">
                {{ mobileError }}
              </small>
            </div>
            <div class="form-field">
              <label for="account-city">城市</label>
              <input
                id="account-city"
                v-model="form.city"
                maxlength="80"
                autocomplete="address-level2"
              />
            </div>
            <div class="form-field">
              <label for="account-company">公司</label>
              <input
                id="account-company"
                v-model="form.company"
                maxlength="160"
                autocomplete="organization"
              />
            </div>
            <div class="form-field">
              <label for="account-title">职位</label>
              <input
                id="account-title"
                v-model="form.title"
                maxlength="100"
                autocomplete="organization-title"
              />
            </div>
            <div class="form-field full">
              <label for="account-bio">个人简介</label>
              <textarea
                id="account-bio"
                v-model="form.bio"
                maxlength="2000"
                placeholder="简要说明你的大会职责与协作范围"
              ></textarea>
            </div>
            <div class="form-field full">
              <label for="account-tags">协作标签</label>
              <input
                id="account-tags"
                v-model="form.tags"
                placeholder="大会运营、内容管理"
                aria-describedby="account-tags-help"
              />
              <small id="account-tags-help">使用顿号或逗号分隔，最多 30 个。</small>
            </div>
          </div>
          <div class="event-form-actions settings-form-actions">
            <span class="account-save-note">
              {{ dirty ? '有修改等待保存' : '资料已与账号同步' }}
            </span>
            <button class="button" type="submit" :disabled="pending || !dirty">
              {{ pending ? '保存中…' : '保存个人资料' }}
            </button>
          </div>
        </form>
      </section>

      <aside class="admin-panel account-access-panel" aria-labelledby="account-access-title">
        <header class="admin-panel-header">
          <div>
            <h2 id="account-access-title">组织访问</h2>
            <p>角色与权限由组织管理员统一维护。</p>
          </div>
        </header>
        <dl class="account-access-list">
          <div>
            <dt>组织</dt>
            <dd>{{ account.organization.name }}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>{{ roleLabel }}</dd>
          </div>
          <div>
            <dt>权限范围</dt>
            <dd>{{ permissionSummary }}</dd>
          </div>
          <div>
            <dt>成员状态</dt>
            <dd>正常使用</dd>
          </div>
        </dl>
        <p class="account-access-note">
          如需调整角色或工作范围，请联系拥有成员管理权限的组织管理员。
        </p>
      </aside>
    </div>
  </template>
</template>
