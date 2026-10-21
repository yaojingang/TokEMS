<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NAVIGATION_PAGES,
  NAVIGATION_SECTIONS,
  NavigationItemsSchema,
  type NavigationItem,
  type TemplateHome,
} from '@conference/contracts';

const props = withDefaults(
  defineProps<{ home: TemplateHome; disabled?: boolean; validate?: boolean }>(),
  {
    validate: true,
  },
);
const items = defineModel<NavigationItem[]>({ required: true });
defineEmits<{ reset: [] }>();
const dragged = ref<number | null>(null);
const validation = computed(() => NavigationItemsSchema.safeParse(items.value));
const sectionOptions = computed(() =>
  NAVIGATION_SECTIONS.filter((section) =>
    props.home.blocks.some((block) => block.nodeKey === section.value),
  ),
);
function add() {
  items.value = [
    ...items.value,
    {
      id: crypto.randomUUID(),
      label: '新菜单',
      kind: 'custom',
      target: '/',
      enabled: true,
      newWindow: false,
    },
  ];
}
function move(from: number, to: number) {
  if (props.disabled || from === to || to < 0 || to >= items.value.length) return;
  const next = [...items.value];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  items.value = next;
}
function kindChanged(index: number, kind: string) {
  const item = items.value[index]!;
  items.value[index] = {
    ...item,
    kind,
    target:
      kind === 'section'
        ? (sectionOptions.value[0]?.value ?? 'home.hero')
        : kind === 'page'
          ? 'home'
          : '/',
  } as NavigationItem;
}
function unavailable(item: NavigationItem) {
  return (
    item.kind === 'section' &&
    !props.home.blocks.some((block) => block.nodeKey === item.target && block.enabled)
  );
}
function drop(index: number) {
  if (dragged.value !== null) move(dragged.value, index);
  dragged.value = null;
}
</script>

<template>
  <section class="navigation-editor" aria-labelledby="navigation-editor-heading">
    <div class="editor-heading">
      <div>
        <h3 id="navigation-editor-heading">顶部导航</h3>
        <p>按显示顺序维护菜单，每项最多 16 字，最多 12 项。全部删除后仅保留品牌和原有业务按钮。</p>
      </div>
      <button class="button secondary" type="button" :disabled="disabled" @click="$emit('reset')">
        恢复模板默认菜单
      </button>
    </div>
    <p
      v-if="home.blocks.find((block) => block.nodeKey === 'home.navigation')?.enabled === false"
      class="editor-notice"
      role="status"
    >
      当前模板已关闭顶部导航，启用后这些菜单才会展示。
    </p>
    <ol class="navigation-rows" aria-label="顶部菜单配置">
      <li
        v-for="(item, index) in items"
        :key="item.id"
        :draggable="!disabled"
        @dragstart="dragged = index"
        @dragend="dragged = null"
        @dragover.prevent
        @drop.prevent="drop(index)"
      >
        <div class="row-heading">
          <strong>菜单 {{ index + 1 }}</strong>
          <div class="row-actions">
            <button
              type="button"
              class="button subtle compact"
              :disabled="disabled || index === 0"
              :aria-label="`上移菜单 ${index + 1}`"
              @click="move(index, index - 1)"
            >
              上移
            </button>
            <button
              type="button"
              class="button subtle compact"
              :disabled="disabled || index === items.length - 1"
              :aria-label="`下移菜单 ${index + 1}`"
              @click="move(index, index + 1)"
            >
              下移
            </button>
            <button
              type="button"
              class="button subtle compact"
              :disabled="disabled"
              :aria-label="`删除菜单 ${index + 1}`"
              @click="items = items.filter((_, row) => row !== index)"
            >
              删除
            </button>
          </div>
        </div>
        <div class="navigation-fields">
          <div class="form-field">
            <label :for="`nav-label-${item.id}`">显示文字</label><input
              :id="`nav-label-${item.id}`"
              v-model="item.label"
              :required="validate"
              maxlength="16"
              :disabled="disabled"
            />
          </div>
          <div class="form-field">
            <label :for="`nav-kind-${item.id}`">链接类型</label><select
              :id="`nav-kind-${item.id}`"
              :value="item.kind"
              :disabled="disabled"
              @change="kindChanged(index, ($event.target as HTMLSelectElement).value)"
            >
              <option value="section">大会区块</option>
              <option value="page">大会功能页</option>
              <option value="custom">自定义链接</option>
            </select>
          </div>
          <div class="form-field target-field">
            <label :for="`nav-target-${item.id}`">链接目标</label>
            <select
              v-if="item.kind === 'section'"
              :id="`nav-target-${item.id}`"
              v-model="item.target"
              :disabled="disabled"
            >
              <option v-for="section in sectionOptions" :key="section.value" :value="section.value">
                {{ section.label
                }}{{
                  home.blocks.find((block) => block.nodeKey === section.value)?.enabled
                    ? ''
                    : '（区块已关闭）'
                }}
              </option>
            </select>
            <select
              v-else-if="item.kind === 'page'"
              :id="`nav-target-${item.id}`"
              v-model="item.target"
              :disabled="disabled"
            >
              <option v-for="page in NAVIGATION_PAGES" :key="page.value" :value="page.value">
                {{ page.label }}
              </option>
            </select>
            <input
              v-else
              :id="`nav-target-${item.id}`"
              v-model="item.target"
              :required="validate"
              maxlength="2000"
              placeholder="/ 或 https://example.com/page#section"
              :disabled="disabled"
            />
          </div>
        </div>
        <div class="row-options">
          <label><input v-model="item.enabled" type="checkbox" :disabled="disabled" /> 启用</label><label><input v-model="item.newWindow" type="checkbox" :disabled="disabled" />
            新窗口打开</label><span v-if="unavailable(item)">目标区块已关闭，前台暂不显示此项</span>
        </div>
      </li>
    </ol>
    <p v-if="!items.length" class="editor-notice">当前没有菜单链接，保存后会隐藏链接区域。</p>
    <p v-if="validate && !validation.success" class="admin-error" role="alert">
      {{ validation.error.issues[0]?.message }}
    </p>
    <button
      type="button"
      class="button secondary"
      :disabled="disabled || items.length >= 12"
      @click="add"
    >
      添加菜单
    </button>
  </section>
</template>

<style scoped>
.navigation-editor {
  margin-top: 28px;
  border-top: 1px solid var(--line);
  padding-top: 24px;
}
.editor-heading,
.row-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor-heading h3 {
  margin: 0 0 6px;
  font-family: var(--serif);
  font-size: 20px;
}
.editor-heading p,
.editor-notice {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.editor-heading > button {
  flex-shrink: 0;
}
.navigation-rows {
  display: grid;
  list-style: none;
  padding: 0;
  margin: 18px 0;
}
.navigation-rows > li {
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}
.row-heading strong {
  font-size: 13px;
}
.row-actions {
  display: flex;
  gap: 4px;
}
.row-actions button {
  min-height: 40px;
  min-width: 40px;
}
.navigation-fields {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(120px, 1fr) minmax(180px, 2fr);
  gap: 12px;
  margin-top: 8px;
}
.navigation-fields input,
.navigation-fields select {
  width: 100%;
  min-width: 0;
}
.row-options {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--ink-soft);
}
.row-options label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
}
.row-options input {
  width: 16px;
  height: 16px;
}
.row-options span {
  align-self: center;
  color: var(--muted);
}
.editor-notice {
  margin-bottom: 12px;
}
@media (max-width: 820px) {
  .editor-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .navigation-fields {
    grid-template-columns: 1fr 1fr;
  }
  .target-field {
    grid-column: 1 / -1;
  }
}
@media (max-width: 480px) {
  .navigation-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .row-heading {
    align-items: flex-start;
  }
  .row-actions {
    gap: 0;
  }
}
</style>
