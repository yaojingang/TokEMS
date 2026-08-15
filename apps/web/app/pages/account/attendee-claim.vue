<script setup lang="ts">
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  consumeAttendeeClaimCredential,
  initializeAttendeeClaimPage,
  isTerminalAttendeeClaimStatus,
  type AttendeeClaimSessionStorage,
} from '~/utils/attendee-claim-session';
import { parseAttendeeClaimFragment } from '~/utils/purchase-journey';

const customer = useCustomerSession();
const credential = ref<ReturnType<typeof parseAttendeeClaimFragment>>(null);
const loading = ref(true);
const claiming = ref(false);
const errorMessage = ref('');
const terminalError = ref(false);
const claimedRegistrationId = ref('');

function claimSessionStorage(): AttendeeClaimSessionStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearFragment() {
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
}

function safeClaimError(error: unknown) {
  const value = error as { status?: number; statusCode?: number; response?: { status?: number } };
  const status = value.status ?? value.statusCode ?? value.response?.status;
  if (status === 401) return '认领链接已失效或已经使用，请联系购票人重新发送。';
  if (status === 403) return '当前登录手机号与参会人手机号不一致，请切换账号后重试。';
  if (status === 409) return '该参会名额已经认领，或当前账号已有本场大会名额。';
  return '暂时无法认领参会名额，请稍后重试。';
}

function claimErrorStatus(error: unknown) {
  const value = error as { status?: number; statusCode?: number; response?: { status?: number } };
  return value.status ?? value.statusCode ?? value.response?.status;
}

async function claim() {
  if (!credential.value) return;
  if (!customer.session.value) {
    customer.openLogin();
    return;
  }
  claiming.value = true;
  errorMessage.value = '';
  try {
    const result = await customer.claimAttendee(credential.value);
    claimedRegistrationId.value = result.registration.id;
    const storage = claimSessionStorage();
    if (storage) consumeAttendeeClaimCredential(storage, credential.value.registrationId);
    credential.value = null;
  } catch (error) {
    errorMessage.value = safeClaimError(error);
    if (isTerminalAttendeeClaimStatus(claimErrorStatus(error))) {
      const storage = claimSessionStorage();
      if (storage && credential.value) {
        consumeAttendeeClaimCredential(storage, credential.value.registrationId);
      }
      credential.value = null;
      terminalError.value = true;
    }
  } finally {
    claiming.value = false;
  }
}

onMounted(async () => {
  const storage = claimSessionStorage();
  credential.value = storage
    ? await initializeAttendeeClaimPage({
        fragment: window.location.hash,
        storage,
        clearFragment,
        refreshSession: customer.refresh,
        hasSession: () => Boolean(customer.session.value),
        openLogin: customer.openLogin,
      })
    : parseAttendeeClaimFragment(window.location.hash);
  if (!storage) {
    clearFragment();
    await customer.refresh().catch(() => null);
    if (!customer.session.value && credential.value) customer.openLogin();
  }
  loading.value = false;
});

onBeforeUnmount(() => {
  credential.value = null;
});

useHead({
  title: '认领参会名额',
  meta: [
    { name: 'referrer', content: 'no-referrer' },
    { 'http-equiv': 'Cache-Control', content: 'no-store' },
  ],
});
</script>

<template>
  <div class="flow-page claim-page">
    <FlowHeader />
    <main id="main-content" class="claim-shell">
      <p class="flow-eyebrow">ATTENDEE CLAIM</p>
      <h1>把参会名额保存到你的账户</h1>
      <p class="claim-lead">认领后可查看本人报名、电子票和参会名片。订单金额与发票仍由购票人管理。</p>

      <p v-if="loading" class="claim-status" role="status">正在确认登录状态…</p>
      <section v-else-if="claimedRegistrationId" class="claim-result" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <h2>参会名额已认领</h2>
          <p>这条报名已经出现在“我的参会名额”中。</p>
          <NuxtLink :to="`/account/registrations/${claimedRegistrationId}`">
            查看本人报名 →
          </NuxtLink>
        </div>
      </section>
      <section v-else-if="terminalError" class="claim-result is-error" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <h2>当前链接无法继续认领</h2>
          <p>{{ errorMessage }}</p>
          <NuxtLink to="/account">返回个人中心 →</NuxtLink>
        </div>
      </section>
      <section v-else-if="!credential" class="claim-result is-error" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <h2>认领链接不完整</h2>
          <p>请从购票人转发的最新邀请中重新打开链接。</p>
          <NuxtLink to="/account">返回个人中心 →</NuxtLink>
        </div>
      </section>
      <section v-else class="claim-action">
        <p v-if="customer.session.value">
          当前账号：<strong>{{ customer.session.value.customer.maskedMobile }}</strong>
        </p>
        <p v-else>请先使用参会人的报名手机号登录。</p>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <button class="flow-action" type="button" :disabled="claiming" @click="claim">
          {{
            customer.session.value
              ? claiming
                ? '正在认领…'
                : '确认认领参会名额'
              : '登录后继续'
          }}
        </button>
        <NuxtLink class="claim-back" to="/account">返回个人中心</NuxtLink>
      </section>
    </main>
  </div>
</template>

<style scoped>
.claim-shell {
  width: min(680px, calc(100% - 32px));
  margin: 0 auto;
  padding: clamp(92px, 13vw, 140px) 0 80px;
}
.claim-shell h1 {
  max-width: 12em;
  margin: 12px 0 16px;
  color: #111318;
  font-size: clamp(34px, 6vw, 56px);
  line-height: 1.04;
  text-wrap: balance;
}
.claim-lead {
  max-width: 620px;
  margin: 0 0 38px;
  color: #616b7b;
  line-height: 1.8;
}
.claim-status,
.claim-action,
.claim-result {
  padding: 22px 0;
  border-block: 1px solid #dce1e9;
}
.claim-action {
  display: grid;
  gap: 16px;
}
.claim-action p {
  margin: 0;
  color: #4b5565;
}
.claim-action .flow-action {
  justify-self: start;
}
.claim-back {
  justify-self: start;
  color: #616b7b;
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.claim-result {
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 16px;
}
.claim-result > span {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 50%;
  background: #1f5fe0;
  color: #fff;
  font-weight: 800;
}
.claim-result.is-error > span {
  background: #111318;
}
.claim-result h2,
.claim-result p {
  margin: 0 0 8px;
}
.claim-result a {
  color: #1f5fe0;
  font-weight: 760;
}
@media (max-width: 520px) {
  .claim-shell {
    width: min(100% - 24px, 680px);
    padding-top: 80px;
  }
}
</style>
