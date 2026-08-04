<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRole,
} from '@conference/contracts';
import { conferenceApi, session } from '../lib/api';
import { buildOrganizationInvitationAcceptanceUrl } from '../lib/organization-invitation';
import { useSettingsFormScope } from '../composables/settings-form-state';

interface RolePreset {
  value: OrganizationRole;
  label: string;
  description: string;
  grants: string[];
}

const rolePresets: RolePreset[] = [
  {
    value: 'organization_admin',
    label: '组织管理员',
    description: '管理大会、成员、组织设置与全部运营能力',
    grants: ['*'],
  },
  {
    value: 'event_owner',
    label: '大会负责人',
    description: '配置和运营大会，并查看组织成员',
    grants: [
      'event.*',
      'customer.read',
      'customer.manage',
      'org.member.read',
      'org.template.use',
      'org.template.read',
    ],
  },
  {
    value: 'finance',
    label: '财务',
    description: '查看订单与发起退款',
    grants: [
      'event.read',
      'event.dashboard.read',
      'event.registration.read',
      'event.registration.export',
      'event.order.read',
      'event.order.refund',
      'event.audit.read',
      'org.invoice.read',
      'org.invoice.manage',
      'org.invoice.export',
    ],
  },
  {
    value: 'content_manager',
    label: '内容管理员',
    description: '维护嘉宾、议程、前台体验与 AI 文案，上线大会保存后立即生效',
    grants: [
      'event.read',
      'event.content.manage',
      'event.site.read',
      'event.ai.read',
      'event.ai.generate',
      'event.ai.approve',
      'event.notification.read',
      'org.template.use',
      'org.template.read',
      'org.template.manage',
      'org.template.publish',
      'org.template.ai.generate',
    ],
  },
  {
    value: 'operator',
    label: '现场运营',
    description: '维护票种、报名和现场运营，上线大会票种保存后立即生效',
    grants: [
      'event.read',
      'event.dashboard.read',
      'event.inventory.read',
      'event.inventory.manage',
      'event.registration.read',
      'event.registration.manage',
      'event.registration.export',
      'event.notification.read',
      'event.notification.send',
      'event.checkin.execute',
      'event.checkin.manage',
    ],
  },
  {
    value: 'viewer',
    label: '只读成员',
    description: '查看数据概览、报名和订单',
    grants: ['event.read', 'event.dashboard.read', 'event.registration.read', 'event.order.read'],
  },
];

const members = ref<OrganizationMember[]>([]);
const invitations = ref<OrganizationInvitation[]>([]);
const errorMessage = ref('');
const message = ref('');
const editingId = ref('');
const pending = ref(false);
const invitationPending = ref(false);
const acceptanceLink = ref('');
const inviteForm = reactive({
  email: '',
  role: 'operator' as OrganizationRole,
});
const memberForm = reactive({
  name: '',
  mobile: '',
  role: 'viewer' as OrganizationRole,
  grants: '',
  company: '',
  title: '',
  city: '',
  bio: '',
  tags: '',
});
const { clearDirty, setBusy, setDirty, setResetHandler } = useSettingsFormScope();
const inviteBaseline = ref(readInviteDraft());
const memberBaseline = ref<ReturnType<typeof readMemberDraft> | null>(null);

const roleLabels = Object.fromEntries(rolePresets.map((item) => [item.value, item.label]));
const canManageMembers = computed(() => session.can('org.member.manage'));
const editingMember = computed(() => members.value.find((item) => item.id === editingId.value));
const editingSelf = computed(() => Boolean(editingMember.value && isSelf(editingMember.value)));
const delegableRolePresets = computed(() =>
  rolePresets.filter(
    (preset) =>
      session.can('*') ||
      (preset.value !== 'organization_admin' && preset.grants.every((grant) => session.can(grant))),
  ),
);
const pendingInvitations = computed(() =>
  invitations.value.filter((item) => item.status === 'pending'),
);
const inviteDirty = computed(
  () => JSON.stringify(readInviteDraft()) !== JSON.stringify(inviteBaseline.value),
);
const memberDirty = computed(
  () =>
    Boolean(editingId.value && memberBaseline.value) &&
    JSON.stringify(readMemberDraft()) !== JSON.stringify(memberBaseline.value),
);

function readInviteDraft() {
  return { email: inviteForm.email, role: inviteForm.role };
}

function readMemberDraft() {
  return { ...memberForm };
}

function resetDrafts() {
  Object.assign(inviteForm, inviteBaseline.value);
  if (memberBaseline.value) Object.assign(memberForm, memberBaseline.value);
}

function syncDirtyState() {
  setDirty(inviteDirty.value || memberDirty.value);
}

setResetHandler(resetDrafts);
watch([inviteDirty, memberDirty], syncDirtyState, { immediate: true });
watch([pending, invitationPending], () => setBusy(pending.value || invitationPending.value), {
  immediate: true,
});

async function load() {
  errorMessage.value = '';
  try {
    const [loadedMembers, loadedInvitations] = await Promise.all([
      conferenceApi.getMembers(),
      conferenceApi.getInvitations(),
    ]);
    members.value = loadedMembers;
    invitations.value = loadedInvitations;
    if (
      canManageMembers.value &&
      !delegableRolePresets.value.some((preset) => preset.value === inviteForm.role)
    ) {
      inviteForm.role = delegableRolePresets.value[0]?.value ?? 'viewer';
    }
    inviteBaseline.value = readInviteDraft();
    clearDirty();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '成员与邀请读取失败';
  }
}

onMounted(load);

function applyMemberRolePreset() {
  const preset = rolePresets.find((item) => item.value === memberForm.role);
  if (preset) memberForm.grants = preset.grants.join('\n');
}

function edit(item: OrganizationMember) {
  if (
    memberDirty.value &&
    !window.confirm('当前成员资料有未保存的更改。切换成员会放弃这些更改，确定继续吗？')
  ) {
    return;
  }
  editingId.value = item.id;
  Object.assign(memberForm, {
    name: item.name,
    mobile: item.mobile ?? '',
    role: item.role as OrganizationRole,
    grants: item.grants.join('\n'),
    company: item.profile?.company ?? '',
    title: item.profile?.title ?? '',
    city: item.profile?.city ?? '',
    bio: item.profile?.bio ?? '',
    tags: item.profile?.tags.join('、') ?? '',
  });
  memberBaseline.value = readMemberDraft();
  syncDirtyState();
}

function closeEditor() {
  if (
    memberDirty.value &&
    !window.confirm('当前成员资料有未保存的更改。关闭后这些更改会丢失，确定继续吗？')
  ) {
    return;
  }
  if (memberBaseline.value) Object.assign(memberForm, memberBaseline.value);
  editingId.value = '';
  memberBaseline.value = null;
  syncDirtyState();
}

async function saveMember() {
  pending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.updateMember(editingId.value, {
      name: memberForm.name.trim(),
      mobile: memberForm.mobile.trim() || null,
      role: memberForm.role,
      grants: memberForm.grants
        .split(/\n|,|，/)
        .map((item) => item.trim())
        .filter(Boolean),
      profile: {
        company: memberForm.company.trim() || null,
        title: memberForm.title.trim() || null,
        city: memberForm.city.trim() || null,
        bio: memberForm.bio.trim() || null,
        tags: memberForm.tags
          .split(/、|,|，/)
          .map((item) => item.trim())
          .filter(Boolean),
      },
    });
    const index = members.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) members.value[index] = updated;
    editingId.value = '';
    memberBaseline.value = null;
    syncDirtyState();
    message.value = '成员角色、权限与组织档案已更新。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '成员信息保存失败';
  } finally {
    pending.value = false;
  }
}

async function invite() {
  invitationPending.value = true;
  message.value = '';
  errorMessage.value = '';
  acceptanceLink.value = '';
  try {
    const preset = rolePresets.find((item) => item.value === inviteForm.role);
    if (!preset) throw new Error('请选择有效角色');
    const result = await conferenceApi.createInvitation({
      email: inviteForm.email.trim(),
      role: preset.value,
      grants: preset.grants,
    });
    invitations.value.unshift(result.invitation);
    acceptanceLink.value = buildOrganizationInvitationAcceptanceUrl(
      result.acceptanceToken,
      session.identity.value?.organization.slug ?? '',
    );
    inviteForm.email = '';
    inviteBaseline.value = readInviteDraft();
    syncDirtyState();
    message.value = '邀请已创建，请复制一次性链接并发送给成员。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '邀请创建失败';
  } finally {
    invitationPending.value = false;
  }
}

async function copyAcceptanceLink() {
  await navigator.clipboard.writeText(acceptanceLink.value);
  message.value = '邀请链接已复制。';
}

async function updateStatus(item: OrganizationMember) {
  const nextStatus = item.status === 'active' ? 'disabled' : 'active';
  const verb = nextStatus === 'disabled' ? '停用' : '启用';
  if (!window.confirm(`确认${verb}成员“${item.name}”？`)) return;
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.updateMemberStatus(item.id, nextStatus);
    const index = members.value.findIndex((member) => member.id === updated.id);
    if (index >= 0) members.value[index] = updated;
    message.value = `成员已${verb}。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `成员${verb}失败`;
  }
}

async function remove(item: OrganizationMember) {
  if (!window.confirm(`确认移除成员“${item.name}”？此操作会撤销其组织访问权限。`)) return;
  errorMessage.value = '';
  try {
    await conferenceApi.removeMember(item.id);
    members.value = members.value.filter((member) => member.id !== item.id);
    message.value = '成员已从组织中移除。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '成员移除失败';
  }
}

async function cancelInvitation(item: OrganizationInvitation) {
  if (!window.confirm(`确认取消发给 ${item.email} 的邀请？`)) return;
  errorMessage.value = '';
  try {
    await conferenceApi.cancelInvitation(item.id);
    invitations.value = invitations.value.filter((invitation) => invitation.id !== item.id);
    message.value = '邀请已取消。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '邀请取消失败';
  }
}

function isSelf(item: OrganizationMember) {
  return item.userId === session.identity.value?.user.id;
}

function canAdminister(item: OrganizationMember) {
  return (
    session.can('*') ||
    (item.role !== 'organization_admin' && item.grants.every((grant) => session.can(grant)))
  );
}
</script>

<template>
  <header class="admin-page-head settings-team-head reveal is-visible">
    <div>
      <p class="eyebrow">TEAM ACCESS</p>
      <h1>团队与权限</h1>
      <p>邀请组织成员，分配角色与访问范围，并维护启用状态。</p>
    </div>
    <span class="status-badge">{{ members.length }} MEMBERS</span>
  </header>

  <p v-if="message" class="admin-success" role="status">{{ message }}</p>
  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>

  <div v-if="canManageMembers" class="member-overview-grid">
    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>邀请新成员</h2>
          <p>角色会自动带入一组清晰、可审计的权限</p>
        </div>
      </header>
      <form
        class="event-form settings-form-spaced"
        data-settings-form
        :inert="invitationPending"
        :aria-busy="invitationPending"
        @submit.prevent="invite"
      >
        <div class="form-grid">
          <div class="form-field full">
            <label for="invite-member-email">成员邮箱</label>
            <input
              id="invite-member-email"
              v-model="inviteForm.email"
              type="email"
              required
              placeholder="name@example.com"
            />
          </div>
          <div class="form-field full">
            <label for="invite-member-role">角色</label>
            <select id="invite-member-role" v-model="inviteForm.role">
              <option
                v-for="preset in delegableRolePresets"
                :key="preset.value"
                :value="preset.value"
              >
                {{ preset.label }} · {{ preset.description }}
              </option>
            </select>
          </div>
        </div>
        <div class="event-form-actions">
          <button class="button" type="submit" :disabled="invitationPending">
            {{ invitationPending ? '创建中…' : '创建邀请' }}
          </button>
        </div>
      </form>
      <div v-if="acceptanceLink" class="invitation-link">
        <span>一次性邀请链接</span>
        <code>{{ acceptanceLink }}</code>
        <button class="button secondary compact" type="button" @click="copyAcceptanceLink">
          复制链接
        </button>
      </div>
    </section>

    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>待接受邀请</h2>
          <p>邀请链接在接受、取消或到期后失效</p>
        </div>
        <span class="status-badge draft">{{ pendingInvitations.length }} PENDING</span>
      </header>
      <ul class="invitation-list">
        <li v-for="item in pendingInvitations" :key="item.id">
          <span>
            <strong>{{ item.email }}</strong>
            <small>{{ roleLabels[item.role] ?? item.role }} ·
              {{ new Date(item.expiresAt).toLocaleDateString('zh-CN') }} 到期</small>
          </span>
          <button class="button danger compact" type="button" @click="cancelInvitation(item)">
            取消
          </button>
        </li>
        <li v-if="!pendingInvitations.length" class="admin-empty">当前没有待接受邀请。</li>
      </ul>
    </section>
  </div>

  <section v-if="canManageMembers && editingId" class="admin-panel editor-panel">
    <header class="admin-panel-header">
      <div>
        <h2>编辑成员</h2>
        <p>切换角色会载入对应权限预设，详细权限可在高级设置中调整。</p>
      </div>
      <button class="button secondary compact" type="button" @click="closeEditor">关闭</button>
    </header>
    <form
      class="event-form settings-form-spaced"
      data-settings-form
      :inert="pending"
      :aria-busy="pending"
      @submit.prevent="saveMember"
    >
      <div class="form-grid">
        <div class="form-field">
          <label for="member-name">姓名</label><input id="member-name" v-model="memberForm.name" required />
        </div>
        <div class="form-field">
          <label for="member-mobile">手机号</label><input id="member-mobile" v-model="memberForm.mobile" />
        </div>
        <div class="form-field">
          <label for="member-role">组织角色</label>
          <select
            id="member-role"
            v-model="memberForm.role"
            :disabled="editingSelf"
            @change="applyMemberRolePreset"
          >
            <option
              v-for="preset in delegableRolePresets"
              :key="preset.value"
              :value="preset.value"
            >
              {{ preset.label }}
            </option>
          </select>
        </div>
        <div class="form-field">
          <label for="member-city">城市</label><input id="member-city" v-model="memberForm.city" />
        </div>
        <div class="form-field">
          <label for="member-company">公司</label><input id="member-company" v-model="memberForm.company" />
        </div>
        <div class="form-field">
          <label for="member-title">职位</label><input id="member-title" v-model="memberForm.title" />
        </div>
        <div class="form-field full">
          <label for="member-bio">成员简介</label><textarea id="member-bio" v-model="memberForm.bio"></textarea>
        </div>
        <div class="form-field full">
          <label for="member-tags">标签</label><input id="member-tags" v-model="memberForm.tags" placeholder="大会运营、内容" />
        </div>
        <details class="advanced-permissions full">
          <summary>高级权限设置</summary>
          <div class="form-field">
            <label for="member-grants">权限集合（每行一项）</label>
            <textarea
              id="member-grants"
              v-model="memberForm.grants"
              required
              :disabled="editingSelf"
            ></textarea>
          </div>
        </details>
      </div>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="closeEditor">取消</button>
        <button class="button" type="submit" :disabled="pending">
          {{ pending ? '保存中…' : '保存成员' }}
        </button>
      </div>
    </form>
  </section>

  <section class="admin-panel">
    <header class="admin-panel-header">
      <div>
        <h2>成员目录</h2>
        <p>管理员保护规则会阻止停用、移除自己或最后一位管理员</p>
      </div>
    </header>
    <div class="data-table-wrap">
      <table class="data-table">
        <caption class="sr-only">
          组织成员目录
        </caption>
        <thead>
          <tr>
            <th>用户 ID</th>
            <th>成员</th>
            <th>角色</th>
            <th>公司与职位</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in members" :key="item.id">
            <td class="mono-code" data-label="用户 ID">{{ item.userId }}</td>
            <td>
              <span class="row-title">{{ item.name }}{{ isSelf(item) ? '（你）' : '' }}</span>
              <span class="row-sub">{{ item.email }}</span>
            </td>
            <td>
              <span class="status-badge">{{ roleLabels[item.role] ?? item.role }}</span>
            </td>
            <td>
              {{ item.profile?.company ?? '未填写' }}
              <span class="row-sub">{{ item.profile?.title }}</span>
            </td>
            <td>
              <span class="status-badge" :class="item.status === 'active' ? 'paid' : 'draft'">
                {{ item.status === 'active' ? '已启用' : '已停用' }}
              </span>
            </td>
            <td>
              <div v-if="canManageMembers" class="table-actions">
                <button
                  v-if="canAdminister(item)"
                  class="button secondary compact"
                  type="button"
                  @click="edit(item)"
                >
                  编辑
                </button>
                <button
                  v-if="canAdminister(item)"
                  :class="['button compact', item.status === 'active' ? 'danger' : 'secondary']"
                  type="button"
                  :disabled="isSelf(item)"
                  @click="updateStatus(item)"
                >
                  {{ item.status === 'active' ? '停用' : '启用' }}
                </button>
                <button
                  v-if="canAdminister(item)"
                  class="button danger compact"
                  type="button"
                  :disabled="isSelf(item)"
                  @click="remove(item)"
                >
                  移除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!members.length" class="admin-empty">当前组织暂无成员记录。</div>
    </div>
  </section>
</template>
