<script setup lang="ts">
import { useNuxtData } from '#app';
import type { PublicSiteConfiguration } from '@conference/contracts';
import { nextTick, watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  customerOtpRetrySeconds,
  maskCustomerMobile,
  normalizeCustomerMobileInput,
} from '~/utils/customer-auth';

const emit = defineEmits<{ authenticated: [] }>();
const customer = useCustomerSession();
const { data: siteConfiguration } = useNuxtData<PublicSiteConfiguration>(
  'public-site-configuration',
);
const mobile = ref('');
const code = ref('');
const challengeId = ref('');
const developmentCode = ref('');
const expiresAt = ref('');
const resendAvailableAt = ref(0);
const clock = ref(Date.now());
const pending = ref(false);
const errorMessage = ref('');
const consentAccepted = ref(false);
const dialogElement = ref<HTMLElement>();
let openerElement: HTMLElement | null = null;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const step = computed(() => (challengeId.value ? 'verify' : 'mobile'));
const retrySecondsRemaining = computed(() =>
  customerOtpRetrySeconds(resendAvailableAt.value, clock.value),
);
const maskedMobile = computed(() => maskCustomerMobile(mobile.value));

function errorText(error: unknown, fallback: string) {
  const value = error as {
    data?: { message?: string };
    response?: { _data?: { message?: string } };
    message?: string;
  };
  return value.data?.message ?? value.response?._data?.message ?? value.message ?? fallback;
}

function close() {
  if (pending.value) return;
  customer.authDialogOpen.value = false;
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = undefined;
}

function startCountdown(seconds: number) {
  stopCountdown();
  resendAvailableAt.value = Date.now() + seconds * 1_000;
  clock.value = Date.now();
  countdownTimer = setInterval(() => {
    clock.value = Date.now();
    if (retrySecondsRemaining.value === 0) stopCountdown();
  }, 250);
}

function updateMobile(event: Event) {
  const input = event.target as HTMLInputElement;
  const digits = normalizeCustomerMobileInput(input.value);
  mobile.value = digits;
  input.value = digits;
}

function resetChallenge() {
  stopCountdown();
  challengeId.value = '';
  code.value = '';
  developmentCode.value = '';
  expiresAt.value = '';
  resendAvailableAt.value = 0;
  errorMessage.value = '';
}

function resetMobile() {
  resetChallenge();
  consentAccepted.value = false;
}

function resetDialog() {
  mobile.value = '';
  resetMobile();
}

async function requestCode() {
  errorMessage.value = '';
  if (!/^1[3-9]\d{9}$/.test(mobile.value)) {
    errorMessage.value = '请输入有效的中国大陆手机号';
    return;
  }
  pending.value = true;
  try {
    const result = await customer.requestOtp(mobile.value);
    challengeId.value = result.challengeId;
    developmentCode.value = result.developmentCode ?? '';
    expiresAt.value = result.expiresAt;
    code.value = '';
    startCountdown(result.retryAfterSeconds);
  } catch (error) {
    errorMessage.value = errorText(error, '验证码发送失败，请稍后重试');
  } finally {
    pending.value = false;
  }
}

async function resendCode() {
  if (retrySecondsRemaining.value > 0) return;
  await requestCode();
}

async function verifyCode() {
  errorMessage.value = '';
  if (!/^\d{6}$/.test(code.value.trim())) {
    errorMessage.value = '请输入 6 位验证码';
    return;
  }
  if (!consentAccepted.value) {
    errorMessage.value = '请先同意用户协议和隐私政策';
    return;
  }
  pending.value = true;
  try {
    await customer.verifyOtp({
      challengeId: challengeId.value,
      mobile: mobile.value,
      code: code.value,
      termsVersion: siteConfiguration.value?.customerAccounts.termsVersion ?? '',
      privacyVersion: siteConfiguration.value?.customerAccounts.privacyVersion ?? '',
    });
    resetDialog();
    customer.authDialogOpen.value = false;
    emit('authenticated');
  } catch (error) {
    errorMessage.value = errorText(error, '验证码验证失败，请重新输入');
  } finally {
    pending.value = false;
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close();
    return;
  }
  if (event.key !== 'Tab' || !dialogElement.value) return;
  const focusable = [
    ...dialogElement.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    dialogElement.value.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialogElement.value.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => customer.authDialogOpen.value,
  async (open) => {
    if (open) {
      openerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      errorMessage.value = '';
      document.querySelector<HTMLElement>('#__nuxt')?.setAttribute('inert', '');
      document.addEventListener('keydown', handleKeydown);
      await nextTick();
      dialogElement.value?.querySelector<HTMLElement>('[autofocus]')?.focus();
    } else {
      document.querySelector<HTMLElement>('#__nuxt')?.removeAttribute('inert');
      document.removeEventListener('keydown', handleKeydown);
      if (openerElement?.isConnected) openerElement.focus();
      openerElement = null;
    }
  },
);

onBeforeUnmount(() => {
  stopCountdown();
  document.querySelector<HTMLElement>('#__nuxt')?.removeAttribute('inert');
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="auth-dialog">
      <div
        v-if="customer.authDialogOpen.value"
        class="auth-dialog"
        role="presentation"
        @mousedown.self="close"
      >
        <section
          ref="dialogElement"
          class="auth-dialog__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-auth-title"
          tabindex="-1"
        >
          <button
            class="auth-dialog__close"
            type="button"
            aria-label="关闭登录或注册"
            @click="close"
          >
            ×
          </button>
          <p class="auth-dialog__eyebrow">ACCOUNT ACCESS</p>
          <h2 id="customer-auth-title">
            {{ step === 'mobile' ? '手机号登录 / 注册' : '输入验证码' }}
          </h2>
          <p class="auth-dialog__lead">
            {{
              step === 'mobile'
                ? '验证手机号后即可继续，首次使用会自动创建账号。'
                : `验证码已发送至 ${maskedMobile}`
            }}
          </p>

          <form v-if="step === 'mobile'" @submit.prevent="requestCode">
            <label class="auth-field">
              <span>手机号码</span>
              <span class="auth-mobile-input">
                <b>+86</b>
                <input
                  v-model="mobile"
                  type="tel"
                  inputmode="numeric"
                  autocomplete="tel"
                  maxlength="11"
                  autofocus
                  placeholder="请输入 11 位手机号"
                  @input="updateMobile"
                />
              </span>
            </label>
            <button class="auth-primary" type="submit" :disabled="pending">
              {{ pending ? '正在发送…' : '获取验证码' }}
            </button>
          </form>

          <form v-else @submit.prevent="verifyCode">
            <label class="auth-field">
              <span>验证码</span>
              <input
                v-model="code"
                class="auth-code-input"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                autofocus
                placeholder="6 位验证码"
              />
            </label>
            <p v-if="developmentCode" class="auth-development-code">
              演示环境验证码：<strong>{{ developmentCode }}</strong>
            </p>
            <label class="auth-consent">
              <input v-model="consentAccepted" type="checkbox" />
              <span>
                我已阅读并同意
                <a
                  v-if="siteConfiguration?.customerAccounts.termsUrl"
                  :href="siteConfiguration.customerAccounts.termsUrl"
                  target="_blank"
                  rel="noreferrer"
                >用户协议</a>
                <span v-else>用户协议</span>
                和
                <a
                  v-if="siteConfiguration?.customerAccounts.privacyUrl"
                  :href="siteConfiguration.customerAccounts.privacyUrl"
                  target="_blank"
                  rel="noreferrer"
                >隐私政策</a>
                <span v-else>隐私政策</span>
              </span>
            </label>
            <button class="auth-primary" type="submit" :disabled="pending">
              {{ pending ? '正在验证…' : '验证并继续' }}
            </button>
            <div class="auth-code-actions">
              <button
                class="auth-secondary"
                type="button"
                :disabled="pending || retrySecondsRemaining > 0"
                @click="resendCode"
              >
                {{
                  retrySecondsRemaining > 0
                    ? `${retrySecondsRemaining} 秒后重新获取`
                    : '重新获取验证码'
                }}
              </button>
              <button class="auth-secondary" type="button" :disabled="pending" @click="resetMobile">
                更换手机号
              </button>
            </div>
          </form>
          <p v-if="errorMessage" class="auth-error" role="alert">{{ errorMessage }}</p>
          <p v-if="expiresAt && step === 'verify'" class="auth-hint">验证码 5 分钟内有效</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.auth-dialog {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow-y: auto;
  background: rgb(9 14 28 / 48%);
  overscroll-behavior: contain;
}
.auth-dialog__panel {
  position: relative;
  width: min(100%, 420px);
  max-height: calc(100dvh - 48px);
  padding: 32px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 22%);
}
.auth-dialog__close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  color: #71717a;
  font-size: 24px;
  line-height: 1;
}
.auth-dialog__eyebrow {
  margin: 0 0 10px;
  color: var(--conference-primary);
  font-size: 11px;
  font-weight: 760;
  letter-spacing: 0.12em;
}
.auth-dialog h2 {
  margin: 0;
  color: var(--conference-ink);
  font-size: 25px;
  letter-spacing: -0.02em;
}
.auth-dialog__lead {
  margin: 10px 0 24px;
  color: var(--conference-ink-soft);
  font-size: 14px;
  line-height: 1.7;
}
.auth-field {
  display: grid;
  gap: 8px;
  color: var(--conference-ink);
  font-size: 13px;
  font-weight: 650;
}
.auth-mobile-input {
  display: grid;
  grid-template-columns: 52px 1fr;
  min-height: 48px;
  overflow: hidden;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
}
.auth-mobile-input b {
  display: grid;
  place-items: center;
  border-right: 1px solid #e4e4e7;
  background: #fafafa;
  font-size: 13px;
}
.auth-mobile-input input,
.auth-code-input {
  min-width: 0;
  border: 0;
  background: #fff;
  color: var(--conference-ink);
  font: inherit;
  outline: none;
}
.auth-mobile-input input {
  padding: 12px;
}
.auth-field + .auth-field {
  margin-top: 14px;
}
.auth-code-input {
  min-height: 52px;
  padding: 10px 14px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.28em;
}
.auth-mobile-input:focus-within,
.auth-code-input:focus {
  border-color: var(--conference-primary);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 10%);
}
.auth-primary,
.auth-secondary {
  width: 100%;
  min-height: 46px;
  margin-top: 18px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 720;
  transition:
    transform 160ms ease,
    background-color 160ms ease;
  touch-action: manipulation;
}
.auth-primary {
  background: var(--conference-primary);
  color: #fff;
}
.auth-primary:active,
.auth-secondary:active {
  transform: scale(0.96);
}
.auth-primary:disabled,
.auth-secondary:disabled {
  cursor: wait;
  opacity: 0.58;
}
.auth-secondary {
  margin-top: 0;
  background: #f4f4f5;
  color: #3f3f46;
}
.auth-code-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.auth-code-actions .auth-secondary {
  min-height: 44px;
  padding: 0 10px;
  font-size: 12px;
}
.auth-code-actions .auth-secondary:disabled {
  cursor: default;
}
.auth-consent {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  margin-top: 16px;
  color: var(--conference-ink-muted);
  font-size: 12px;
  font-weight: 450;
  line-height: 1.65;
}
.auth-consent input {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  accent-color: var(--conference-primary);
}
.auth-consent a {
  color: var(--conference-primary);
}
.auth-error,
.auth-development-code {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 7px;
  font-size: 12px;
}
.auth-error {
  background: #fff1f2;
  color: #be123c;
}
.auth-development-code {
  background: #eff6ff;
  color: #1e40af;
  font-variant-numeric: tabular-nums;
}
.auth-hint {
  margin: 14px 0 0;
  color: var(--conference-ink-muted);
  font-size: 11px;
  text-align: center;
}
.auth-dialog-enter-active,
.auth-dialog-leave-active {
  transition: opacity 180ms ease;
}
.auth-dialog-enter-active .auth-dialog__panel,
.auth-dialog-leave-active .auth-dialog__panel {
  transition:
    opacity 180ms ease,
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.auth-dialog-enter-from,
.auth-dialog-leave-to,
.auth-dialog-enter-from .auth-dialog__panel,
.auth-dialog-leave-to .auth-dialog__panel {
  opacity: 0;
}
.auth-dialog-enter-from .auth-dialog__panel {
  transform: translateY(12px);
}
.auth-dialog-leave-to .auth-dialog__panel {
  transform: translateY(-12px);
}
@media (max-width: 480px) {
  .auth-dialog {
    align-items: end;
    padding: 0;
  }
  .auth-dialog__panel {
    width: 100%;
    min-height: 100dvh;
    max-height: 100dvh;
    padding: calc(28px + env(safe-area-inset-top)) 22px calc(24px + env(safe-area-inset-bottom));
    border-radius: 0;
  }
  .auth-code-actions {
    grid-template-columns: 1fr;
  }
  .auth-dialog__close {
    width: 44px;
    height: 44px;
  }
  .auth-mobile-input input {
    font-size: 16px;
  }
}
@media (max-height: 520px) {
  .auth-dialog {
    align-items: start;
    padding: 12px;
  }
  .auth-dialog__panel {
    min-height: 0;
    max-height: calc(100dvh - 24px);
    padding: 24px 22px;
    border-radius: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .auth-dialog-enter-active,
  .auth-dialog-leave-active,
  .auth-dialog-enter-active .auth-dialog__panel,
  .auth-dialog-leave-active .auth-dialog__panel {
    transition-duration: 1ms;
  }
}
</style>
