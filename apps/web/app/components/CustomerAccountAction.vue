<script setup lang="ts">
import { useCustomerSession } from '~/composables/useCustomerSession';

const customer = useCustomerSession();
</script>

<template>
  <span
    v-if="!customer.loaded.value"
    class="customer-account-action is-loading"
    role="status"
    aria-label="正在确认登录状态"
  >
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M10 10.25a3.375 3.375 0 1 0 0-6.75 3.375 3.375 0 0 0 0 6.75Zm-5.25 5.5c.55-2.08 2.62-3.5 5.25-3.5s4.7 1.42 5.25 3.5"
      />
    </svg>
    <span>账户</span>
  </span>
  <NuxtLink
    v-else-if="customer.session.value"
    class="customer-account-action"
    to="/account"
    aria-label="前往个人中心"
  >
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M10 10.25a3.375 3.375 0 1 0 0-6.75 3.375 3.375 0 0 0 0 6.75Zm-5.25 5.5c.55-2.08 2.62-3.5 5.25-3.5s4.7 1.42 5.25 3.5"
      />
    </svg>
    <span>个人中心</span>
  </NuxtLink>
  <button
    v-else
    class="customer-account-action"
    type="button"
    aria-label="登录或注册账号"
    @click="customer.openLogin"
  >
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M10 10.25a3.375 3.375 0 1 0 0-6.75 3.375 3.375 0 0 0 0 6.75Zm-5.25 5.5c.55-2.08 2.62-3.5 5.25-3.5s4.7 1.42 5.25 3.5"
      />
    </svg>
    <span>登录 / 注册</span>
  </button>
</template>

<style scoped>
.customer-account-action {
  display: inline-flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
  border: 1px solid #d4d4d8;
  border-radius: 7px;
  background: #fff;
  color: var(--conference-ink, #171717);
  font-size: 13.5px;
  font-weight: 680;
  line-height: 1;
  white-space: nowrap;
  transition:
    transform 160ms ease,
    border-color 160ms ease,
    background-color 160ms ease,
    color 160ms ease;
}
.customer-account-action svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.65;
}
.customer-account-action.is-loading {
  cursor: default;
  opacity: 0.56;
}
.customer-account-action:active {
  transform: scale(0.96);
}
@media (hover: hover) {
  .customer-account-action:hover {
    border-color: var(--conference-primary, #2563eb);
    background: var(--conference-primary-soft, #eff6ff);
    color: var(--conference-primary, #2563eb);
  }
}
@media (max-width: 640px) {
  .customer-account-action {
    min-height: 44px;
    padding-inline: 11px;
    font-size: 12.5px;
  }
}
</style>
