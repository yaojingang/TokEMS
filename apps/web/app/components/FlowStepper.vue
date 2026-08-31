<script setup lang="ts">
import { resolveComponent } from 'vue';
import { enumerateLinkedFlowSteps } from '~/utils/flow-stepper-actions';

type FlowStepInput =
  | string
  | {
      title: string;
      to?: string;
      hint?: string;
    };

const props = withDefaults(
  defineProps<{
    active: number;
    paymentRequired?: boolean;
    steps?: FlowStepInput[];
    variant?: 'steps' | 'compact' | 'minimal';
  }>(),
  {
    paymentRequired: true,
    steps: undefined,
    variant: 'steps',
  },
);

const NuxtLink = resolveComponent('NuxtLink');
const resolvedSteps = computed(() =>
  (
    (props.steps?.length ? props.steps : undefined) ?? [
      '填写报名信息',
      props.paymentRequired ? '确认订单并支付' : '确认报名',
      '获取电子票',
    ]
  ).map((step) => (typeof step === 'string' ? { title: step } : step)),
);
const resolvedStepCount = computed(() => Math.max(resolvedSteps.value.length, 1));
const resolvedActive = computed(() => Math.min(Math.max(props.active, 1), resolvedStepCount.value));
const currentStepTitle = computed(
  () => resolvedSteps.value[resolvedActive.value - 1]?.title ?? '当前步骤',
);
const progress = computed(() => Math.round((resolvedActive.value / resolvedStepCount.value) * 100));
const linkedActionSteps = computed(() => enumerateLinkedFlowSteps(resolvedSteps.value));
</script>

<template>
  <div
    class="flow-stepper"
    :class="[`is-${variant}`]"
    role="group"
    :aria-label="`报名进度：第 ${resolvedActive} 步，共 ${resolvedStepCount} 步，${currentStepTitle}`"
  >
    <div
      class="flow-stepper__mobile"
      :style="{ '--flow-progress': `${progress}%` }"
      aria-hidden="true"
    >
      <span>第 {{ resolvedActive }} / {{ resolvedStepCount }} 步</span>
      <strong>{{ currentStepTitle }}</strong>
      <i></i>
    </div>
    <div class="flow-stepper__steps">
      <component
        v-for="(step, index) in resolvedSteps"
        :is="step.to ? NuxtLink : 'div'"
        :key="`${index}-${step.title}`"
        :to="step.to"
        class="flow-step"
        :class="{
          'is-active': resolvedActive === index + 1,
          'is-done': resolvedActive > index + 1,
          'is-action': Boolean(step.to),
        }"
        :aria-current="resolvedActive === index + 1 ? 'step' : undefined"
        :aria-label="step.to ? `前往第 ${index + 1} 步：${step.title}` : undefined"
      >
        <span class="flow-step__number">{{
          resolvedActive > index + 1 ? '✓' : String(index + 1).padStart(2, '0')
        }}</span>
        <span class="flow-step__copy">
          <span>{{ step.title }}</span>
          <small v-if="step.to">{{ step.hint ?? '点击继续 →' }}</small>
        </span>
      </component>
    </div>
    <div
      v-if="linkedActionSteps.length"
      class="flow-stepper__next-actions"
      aria-label="可继续处理的报名事项"
    >
      <NuxtLink
        v-for="step in linkedActionSteps"
        :key="`${step.number}-${step.title}`"
        :to="step.to!"
      >
        <span>{{ String(step.number).padStart(2, '0') }}</span>
        <strong>{{ step.title }}</strong>
        <small>{{ step.hint ?? '点击继续 →' }}</small>
      </NuxtLink>
    </div>
  </div>
</template>
