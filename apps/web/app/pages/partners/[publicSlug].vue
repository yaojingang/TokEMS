<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { renderPersonalEventPoster } from '~/utils/personal-event-poster';
import { useAsyncData, useRequestURL } from '#imports';
import { publicEventHomePath, publicEventScopedPath } from '@conference/contracts';
import QRCode from 'qrcode.vue';

const route = useRoute();
const requestUrl = useRequestURL();
const api = useConferenceApi();
const eventSlug = computed(() => String(route.query.event ?? ''));
const publicSlug = computed(() => String(route.params.publicSlug ?? ''));
const copied = ref(false);
const { data: partner, error } = await useAsyncData(
  () => `event-partner:${eventSlug.value}:${publicSlug.value}`,
  () => api.getEventPartner(eventSlug.value, publicSlug.value),
  { watch: [eventSlug, publicSlug] },
);
const identity = computed(() =>
  [partner.value?.company, partner.value?.title].filter(Boolean).join(' · '),
);
const publicPoster = ref<HTMLCanvasElement | null>(null);
const publicQr = ref<HTMLElement | null>(null);
const publicPosterError = ref('');
async function renderPublicPoster() {
  await nextTick();
  const value = partner.value;
  const qr = publicQr.value?.querySelector('canvas');
  if (!value || !publicPoster.value || !qr) return;
  try {
    await renderPersonalEventPoster(publicPoster.value, qr, {
      variant: 'partner', eventName: value.event.name, eventMark: value.event.name,
      eventLine: `${new Date(value.event.startsAt).toLocaleDateString('zh-CN')} · ${value.event.city}`, location: value.event.city,
      content: {
        invitation: value.posterCopy?.invitation || null,
        callToAction: value.posterCopy?.callToAction || null,
        scanHint: value.posterCopy?.scanHint || null,
        displayName: value.posterFields.displayName ? value.displayName : null,
        company: value.posterFields.company ? value.company : null,
        title: value.posterFields.title ? value.title : null,
        industryLabel: value.posterFields.industry ? value.industry : null,
        businessIntro: value.posterCopy?.introduction || (value.posterFields.businessIntro ? value.businessIntro : null),
        avatarUrl: value.posterFields.avatar ? value.avatarUrl : null,
      },
    });
  } catch { publicPosterError.value = '海报暂时无法生成，请刷新重试'; }
}
onMounted(renderPublicPoster);
watch(partner, renderPublicPoster, { flush: 'post' });
const profileFields = computed(() => {
  const fields = [
    ['company', '公司'],
    ['title', '职位'],
    ['industry', '行业'],
    ['businessIntro', '个人或业务介绍'],
    ['businessUrl', '项目网址'],
    ['contactPhone', '联系电话'],
    ['contactEmail', '联系邮箱'],
    ['wechatId', '微信号'],
  ] as const;
  return fields.flatMap(([key, label]) => {
    const value = partner.value?.[key]?.trim();
    return value ? [{ key, label, value, wide: key === 'businessIntro' || key === 'businessUrl' }] : [];
  });
});
const referralUrl = computed(() =>
  partner.value?.referralPath ? new URL(partner.value.referralPath, requestUrl.origin).toString() : requestUrl.toString(),
);

async function share() {
  if (!import.meta.client || !partner.value) return;
  const payload = { title: `${partner.value.displayName}·${partner.value.event.name}合作伙伴`, text: `通过${partner.value.displayName}了解并报名${partner.value.event.name}`, url: referralUrl.value };
  if (navigator.share) await navigator.share(payload);
  else { await navigator.clipboard.writeText(referralUrl.value); copied.value = true; window.setTimeout(() => (copied.value = false), 1800); }
}

useHead(() => ({
  title: partner.value ? `${partner.value.displayName}·${partner.value.event.name}合作伙伴` : '合作伙伴',
  meta: [
    { name: 'description', content: partner.value?.businessIntro || '大会合作伙伴介绍' },
    ...(partner.value && !partner.value.searchIndexingEnabled
      ? [{ name: 'robots', content: 'noindex,nofollow' }]
      : []),
  ],
}));
</script>

<template>
  <div class="partner-page">
    <EventPublicNav :event-slug="eventSlug" :event-name="partner?.event.name" />
    <main id="main-content" class="profile-shell">
      <p v-if="error" class="profile-state">该合作伙伴资料已停止公开，或链接已失效。</p>
      <template v-else-if="partner">
        <NuxtLink class="profile-back" :to="`/partners?event=${encodeURIComponent(partner.event.slug)}`">← 返回合作伙伴目录</NuxtLink>
        <section class="profile-layout">
          <article class="profile-card">
            <header class="profile-hero">
              <div class="profile-avatar"><img v-if="partner.avatarUrl" :src="partner.avatarUrl" :alt="`${partner.displayName}的头像`" /><span v-else>{{ partner.displayName.slice(0,1) }}</span></div>
              <div class="profile-summary"><div class="profile-meta"><span>EVENT PARTNER</span><span>{{ partner.industry || '大会合作伙伴' }}</span></div><h1>{{ partner.displayName }}</h1><p v-if="identity" class="profile-role">{{ identity }}</p></div>
            </header>
            <section
              v-if="profileFields.length"
              class="profile-section profile-information"
              aria-labelledby="partner-information-title"
            >
              <div class="section-heading">
                <span>PROFILE</span>
                <h2 id="partner-information-title">合作伙伴资料</h2>
              </div>
              <dl class="profile-fields">
                <div
                  v-for="field in profileFields"
                  :key="field.key"
                  class="profile-field"
                  :class="{ 'profile-field--wide': field.wide }"
                >
                  <dt>{{ field.label }}</dt>
                  <dd>
                    <a
                      v-if="field.key === 'businessUrl'"
                      :href="field.value"
                      target="_blank"
                      rel="nofollow ugc noopener noreferrer"
                    >{{ field.value }}</a>
                    <p v-else>{{ field.value }}</p>
                  </dd>
                </div>
              </dl>
            </section>
            <section v-if="partner.gallery.length" class="profile-section gallery-section"><div class="section-heading"><span>GALLERY</span><h2>图片资料</h2></div><div class="profile-gallery"><figure v-for="item in partner.gallery" :key="item.url"><img :src="item.url" :alt="item.alt" loading="lazy" /><figcaption>{{ item.alt }}</figcaption></figure></div></section>
          </article>
          <aside class="partner-poster">
            <canvas ref="publicPoster" width="1080" height="1440" style="width:100%;height:auto" aria-label="合作伙伴推广海报" /><p v-if="publicPosterError" role="alert">{{ publicPosterError }}</p><div ref="publicQr" style="position:absolute;left:-10000px" aria-hidden="true"><QRCode :value="referralUrl" :size="360" level="M" render-as="canvas" /></div>
            <div class="profile-actions">
              <a
                class="primary-action"
                :href="partner.referralPath || publicEventScopedPath('/register', partner.event.slug)"
              >{{ partner.referralPath ? '通过我报名' : '报名参会' }}</a>
              <button type="button" @click="share">{{ copied ? '链接已复制' : '分享海报与链接' }}</button>
              <NuxtLink :to="publicEventHomePath(partner.event.slug)">查看大会主页</NuxtLink>
            </div>
          </aside>
        </section>
      </template>
      <p v-else class="profile-state">正在读取合作伙伴资料…</p>
    </main>
  </div>
</template>

<style scoped>
.partner-page{min-height:100vh;background:#f4f6f9}.profile-shell{width:min(100% - 40px,1080px);margin:auto;padding:28px 0 64px}.profile-back{display:inline-flex;min-height:36px;align-items:center;margin-bottom:12px;color:#657186;font-size:13px}.profile-layout{display:grid;grid-template-columns:minmax(0,1fr)310px;align-items:start;gap:16px}.profile-card,.partner-poster{border:1px solid #dfe5ee;border-radius:14px;background:#fff;box-shadow:0 12px 34px rgb(28 45 74/6%)}.profile-card{overflow:hidden}.profile-hero{display:grid;grid-template-columns:132px minmax(0,1fr);align-items:center;gap:30px;padding:34px 36px 32px}.profile-avatar{display:grid;width:132px;height:132px;place-items:center;overflow:hidden;border:1px solid #d8e1f0;border-radius:16px;background:#e8efff;box-shadow:0 0 0 6px #f4f7fc;color:#1f5fe8;font-size:42px;font-weight:760}.profile-avatar img{width:100%;height:100%;object-fit:cover}.profile-meta{display:flex;gap:8px}.profile-meta span,.section-heading>span,.poster-art>p,.poster-event>span{color:#1f5fe8;font:720 10px var(--conference-font-mono);letter-spacing:.1em}.profile-meta span+span{padding-left:8px;border-left:1px solid #cbd5e5}.profile-summary h1{margin:10px 0 7px;color:#172033;font-size:clamp(38px,5vw,50px);line-height:1.08;letter-spacing:-.04em}.profile-role{margin:0;color:#4e5a6d;font-size:16px;font-weight:600}.profile-section{display:grid;grid-template-columns:158px minmax(0,1fr);gap:24px;padding:26px 36px;border-top:1px solid #e8edf4}.section-heading h2{margin:6px 0 0;color:#172033;font-size:16px}.profile-section>p{margin:0;color:#404c60;font-size:15px;line-height:1.8;white-space:pre-wrap}.profile-gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.profile-gallery figure{margin:0}.profile-gallery img{width:100%;aspect-ratio:4/3;border-radius:8px;object-fit:cover}.profile-gallery figcaption{margin-top:5px;color:#707d90;font-size:11px}.partner-poster{position:sticky;top:20px;padding:14px}.poster-art{position:relative;display:flex;min-height:390px;flex-direction:column;padding:22px;border-radius:10px;background:linear-gradient(155deg,#122f55 0%,#1f5fe8 65%,#88b7ff 100%);color:#fff;overflow:hidden}.poster-art:after{position:absolute;right:-70px;bottom:60px;width:220px;height:220px;border:1px solid rgb(255 255 255/25%);border-radius:50%;content:""}.poster-art>p{margin:0;color:#b9d4ff}.poster-name{margin-top:50px}.poster-name span,.poster-name small,.poster-event span,.poster-event small{display:block;color:#dceaff}.poster-name strong{display:block;margin:8px 0 5px;font:700 34px/1.1 Georgia,"Songti SC",serif}.poster-event{margin-top:auto}.poster-event b{display:block;margin:6px 0;font-size:16px}.poster-qr{position:relative;z-index:1;display:grid;grid-template-columns:118px 1fr;align-items:end;gap:12px;margin-top:16px}.poster-qr :deep(svg){padding:5px;background:#fff}.poster-qr span{font-size:11px;line-height:1.5}.profile-actions{display:grid;gap:8px;padding:14px 0 0}.profile-actions a,.profile-actions button{display:flex;min-height:42px;align-items:center;justify-content:center;border:1px solid #d6deea;border-radius:8px;background:#fff;color:#29364d;font-size:13px;font-weight:750}.profile-actions .primary-action{border-color:#1f5fe8;background:#1f5fe8;color:#fff}.profile-state{padding:100px 0;color:#6d788a;text-align:center}@media(max-width:820px){.profile-layout{grid-template-columns:1fr}.partner-poster{position:static}.poster-art{min-height:360px}}@media(max-width:560px){.profile-shell{width:min(100% - 24px,680px);padding:16px 0 40px}.profile-hero{grid-template-columns:84px 1fr;gap:18px;padding:24px 20px}.profile-avatar{width:84px;height:84px;font-size:28px}.profile-summary h1{font-size:32px}.profile-section{grid-template-columns:1fr;gap:14px;padding:22px 20px}.profile-gallery{grid-template-columns:1fr}}

.profile-information {
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
}
.profile-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px 32px;
  margin: 0;
}
.profile-field--wide {
  grid-column: 1 / -1;
}
.profile-field dt {
  margin-bottom: 8px;
  color: #657186;
  font-size: 12px;
}
.profile-field dd {
  margin: 0;
  color: #404c60;
  font-size: 15px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.profile-field p {
  margin: 0;
  white-space: pre-wrap;
}
.profile-field a {
  color: #1f5fe8;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.profile-field a:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 4px;
}
.profile-field a:active {
  color: #174ab6;
}
@media (max-width: 560px) {
  .profile-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
}
</style>
