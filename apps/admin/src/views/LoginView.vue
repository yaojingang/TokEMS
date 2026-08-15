<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import { resolveAuthenticatedEntry } from '../router';

const router = useRouter();
const route = useRoute();
const simpleAuth = import.meta.env.VITE_SIMPLE_AUTH === 'true';
const username = ref(simpleAuth ? 'admin' : '');
const password = ref(simpleAuth ? 'admin' : '');
const pending = ref(false);
const errorMessage = ref('');

async function login() {
  pending.value = true;
  errorMessage.value = '';
  try {
    const organizationSlug = String(route.query.organization ?? '').trim();
    session.set(
      await conferenceApi.login(username.value, password.value, organizationSlug || undefined),
    );
    session.setIdentity(await conferenceApi.getMe());
    await router.push(await resolveAuthenticatedEntry(route.query.redirect));
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-story">
      <div class="login-brand">
        <span class="login-brand__mark">T</span><span>TokEMS 运营台</span>
      </div>
      <div class="login-story__copy">
        <small>EVENT OPERATIONS / SHENZHEN 2026</small>
        <h1>从一次报名，到一场有秩序的大会。</h1>
        <p>统一管理大会内容、票种库存、报名审核、订单支付和现场核销。</p>
      </div>
      <span class="login-story__foot">TOKEMS · CONFERENCE OPERATIONS CONSOLE</span>
    </section>
    <section class="login-form-wrap">
      <form class="login-form" @submit.prevent="login">
        <p class="eyebrow">SECURE SIGN IN</p>
        <h2>运营人员登录</h2>
        <p>输入用户名和密码进入管理台。</p>
        <div class="login-fields">
          <label>
            用户名
            <input v-model="username" type="text" autocomplete="username" required autofocus />
          </label>
          <label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label>
        </div>
        <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
        <button class="button" type="submit" :disabled="pending">
          {{ pending ? '正在验证…' : '进入运营台' }}
        </button>
        <p class="login-hint">
          {{ simpleAuth ? '本地调试账号：admin / admin' : '请使用部署时配置的运营账号登录。' }}
        </p>
        <a
          class="login-legal"
          href="https://github.com/yaojingang/TokEMS"
          target="_blank"
          rel="noopener noreferrer"
        >源代码与 AGPL-3.0 许可证</a>
      </form>
    </section>
  </main>
</template>
