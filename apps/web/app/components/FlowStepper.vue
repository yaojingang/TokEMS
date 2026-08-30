<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    active: number;
    paymentRequired?: boolean;
    steps?: string[];
    variant?: 'steps' | 'compact' | 'minimal';
  }>(),
  {
    paymentRequired: true,
    steps: undefined,
    variant: 'steps',
  },
);

const resolvedSteps = computed(
  () =>
    (props.steps?.length ? props.steps : undefined) ?? [
      '填写报名信息',
      props.paymentRequired ? '确认订单并支付' : '确认报名',
      '获取电子票',
    ],
);
const resolvedStepCount = computed(() => Math.max(resolvedSteps.value.length, 1));
const resolvedActive = computed(() => Math.min(Math.max(props.active, 1), resolvedStepCount.value));
const currentStepTitle = computed(
  () => resolvedSteps.value[resolvedActive.value - 1] ?? '当前步骤',
);
const progress = computed(() => Math.round((resolvedActive.value / resolvedStepCount.value) * 100));
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
      <div
        v-for="(step, index) in resolvedSteps"
        :key="step"
        class="flow-step"
        :class="{
          'is-active': resolvedActive === index + 1,
          'is-done': resolvedActive > index + 1,
        }"
        :aria-current="resolvedActive === index + 1 ? 'step' : undefined"
      >
        <span class="flow-step__number">{{
          resolvedActive > index + 1 ? '✓' : String(index + 1).padStart(2, '0')
        }}</span>
        <span>{{ step }}</span>
      </div>
    </div>
  </div>
</template>
