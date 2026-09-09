<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { FeishuBotConfiguration } from '@conference/contracts';
import FeishuConnectionPanel from '../components/feishu/FeishuConnectionPanel.vue';
import { conferenceApi } from '../lib/api';
import '../styles/feishu.css';
const configuration = ref<FeishuBotConfiguration>();
const error = ref('');
let alive = true;
async function load() {
  error.value = '';
  try {
    const result = await conferenceApi.getFeishuBotConfiguration();
    if (alive) configuration.value = result;
  } catch (caught) {
    if (alive)
      error.value = caught instanceof Error ? caught.message : '连接配置读取失败，请重试。';
  }
}
onMounted(load);
onBeforeUnmount(() => {
  alive = false;
});
</script>
<template>
  <div class="feishu-settings">
    <FeishuConnectionPanel
      v-if="configuration"
      :configuration="configuration"
      @updated="configuration = $event"
    />
    <p v-else-if="!error" role="status">正在读取飞书连接…</p>
    <div v-if="error" role="alert" class="feishu-error">
      {{ error }} <button class="button secondary" type="button" @click="load">重新读取</button>
    </div>
    <section v-if="configuration?.affectedEvents.length" class="feishu-connected-events">
      <h3>关联大会</h3>
      <p>接收群、发送时间和记录在各大会配置中管理。</p>
      <ul>
        <li v-for="event in configuration.affectedEvents" :key="event.eventId">
          <RouterLink :to="`/events/${event.eventId}/settings/feishu`">
            {{
              event.eventName
            }}
          </RouterLink><span>{{ event.enabled ? '日报已开启' : '日报已暂停' }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
