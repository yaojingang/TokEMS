<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { publicEventScopedPath, type PublicPartnerSummary } from '@conference/contracts';

const props = withDefaults(
  defineProps<{
    items: PublicPartnerSummary[];
    eventSlug: string;
    context?: 'page' | 'home';
    headingLevel?: 'h1' | 'h2';
  }>(),
  { context: 'page', headingLevel: 'h2' },
);

const partners = computed(() => {
  const seen = new Set<string>();
  return props.items.filter((item) => {
    if (seen.has(item.publicSlug)) return false;
    seen.add(item.publicSlug);
    return true;
  });
});
const headingId = computed(() =>
  props.context === 'home' ? 'event-partners-title' : 'cooperation-partners-title',
);
const listId = computed(() =>
  props.context === 'home' ? 'homepage-partner-list' : 'cooperation-partner-list',
);
const contactHref = computed(() =>
  props.context === 'home'
    ? `${publicEventScopedPath('/apply/cooperation', props.eventSlug)}#cooperation-contact`
    : '#cooperation-contact',
);
const failedPartnerAvatars = ref(new Set<string>());
const partnerList = ref<HTMLOListElement | null>(null);
function recoverFailedPartnerAvatars() {
  for (const image of partnerList.value?.querySelectorAll<HTMLImageElement>('img') ?? []) {
    if (image.complete && image.naturalWidth === 0) {
      const src = image.getAttribute('src');
      if (src) failedPartnerAvatars.value.add(src);
    }
  }
}
onMounted(recoverFailedPartnerAvatars);
watch(partners, recoverFailedPartnerAvatars, { flush: 'post' });
watch(
  () => props.eventSlug,
  () => {
    failedPartnerAvatars.value = new Set();
  },
);
const partnerInitial = (name: string) => Array.from(name.trim())[0] || '伙';
const partnerIntro = (intro: string) => Array.from(intro.trim()).slice(0, 80).join('');
</script>

<template>
  <component
    :is="context === 'home' ? 'div' : 'section'"
    class="cooperation-partners"
    :class="{ 'cooperation-partners--home': context === 'home' }"
    :aria-labelledby="context === 'page' ? headingId : undefined"
  >
    <header class="cooperation-partners__head">
      <div>
        <p class="flow-eyebrow">OUR PARTNERS</p>
        <component :is="headingLevel" :id="headingId">与大会同行的伙伴</component>
      </div>
      <p class="cooperation-partners__count" aria-live="polite">
        <strong>{{ partners.length.toString().padStart(2, '0') }}</strong>
        <span>位伙伴</span>
      </p>
    </header>
    <p class="cooperation-partners__lead">汇聚专业经验与行业资源，让每一次连接都有新的可能。</p>
    <ol :id="listId" ref="partnerList" class="cooperation-partners__list">
      <li v-for="item in partners" :key="item.publicSlug" class="cooperation-partner">
        <NuxtLink
          class="cooperation-partner__card"
          :to="publicEventScopedPath(`/partners/${encodeURIComponent(item.publicSlug)}`, eventSlug)"
          :aria-label="`查看${item.displayName}的公开资料`"
        >
          <div class="cooperation-partner__identity">
            <span class="cooperation-partner__avatar" aria-hidden="true">
              <img
                v-if="item.avatarUrl && !failedPartnerAvatars.has(item.avatarUrl)"
                :src="item.avatarUrl"
                alt=""
                width="72"
                height="72"
                loading="lazy"
                decoding="async"
                @error="failedPartnerAvatars.add(item.avatarUrl!)"
              />
              <span v-else class="cooperation-partner__initial">{{
                partnerInitial(item.displayName)
              }}</span>
            </span>
            <div>
              <component :is="headingLevel === 'h1' ? 'h2' : 'h3'">
                {{
                  item.displayName
                }}
              </component>
              <p v-if="item.company || item.title" class="cooperation-partner__company">
                {{ [item.company, item.title].filter(Boolean).join(' · ') }}
              </p>
            </div>
          </div>
          <p v-if="item.businessIntro" class="cooperation-partner__intro">
            {{ partnerIntro(item.businessIntro) }}
          </p>
          <div class="cooperation-partner__footer">
            <span v-if="item.industry">{{ item.industry }}</span>
            <span class="cooperation-partner__link">
              查看资料 <span aria-hidden="true">→</span>
            </span>
          </div>
        </NuxtLink>
      </li>
    </ol>
    <div class="cooperation-partners__footer">
      <span>更多伙伴，陆续加入</span>
      <NuxtLink :to="contactHref">成为合作伙伴 <span aria-hidden="true">↗</span></NuxtLink>
    </div>
  </component>
</template>

<style scoped>
.cooperation-partners {
  margin-bottom: 48px;
  padding: 0 0 28px;
  border-bottom: 1px solid var(--line);
}

.cooperation-partners__head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}

.cooperation-partners__head :is(h1, h2) {
  margin: 0;
  font-size: clamp(26px, 2.8vw, 36px);
  font-weight: 700;
  line-height: 1.35;
  text-wrap: balance;
}

.cooperation-partners__head .flow-eyebrow {
  margin-bottom: 8px;
}

.cooperation-partners__count {
  display: flex;
  align-items: baseline;
  flex: none;
  gap: 5px;
  margin: 0;
  color: var(--ink-muted);
  font-size: 11px;
}

.cooperation-partners__count strong {
  color: var(--accent);
  font: 500 27px var(--conference-font-mono);
  font-variant-numeric: tabular-nums;
}

.cooperation-partners__lead {
  margin: 14px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
}

.cooperation-partners__list {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 24px var(--cooperation-column-gap, 32px);
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}

.cooperation-partner {
  display: flex;
  min-width: 0;
}

.cooperation-partner__card {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  padding: 18px 0 8px;
  border-top: 1px solid var(--line);
  color: var(--ink);
  text-align: center;
  touch-action: manipulation;
  transition: transform 120ms ease;
}

.cooperation-partner__identity {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.cooperation-partner__identity > div {
  min-width: 0;
  overflow-wrap: anywhere;
}

.cooperation-partner :is(h2, h3) {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.5;
}

.cooperation-partner__avatar {
  display: flex;
  width: 100%;
  height: 82px;
  flex: none;
  align-items: center;
  justify-content: center;
}

.cooperation-partner__initial {
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border-radius: 8px;
  background: var(--accent-light);
  color: var(--accent);
  font-size: 22px;
  font-weight: 650;
}

.cooperation-partner__avatar img {
  width: auto;
  height: auto;
  max-width: min(100%, 160px);
  max-height: 72px;
  border-radius: 8px;
  object-fit: contain;
}

.cooperation-partner__company {
  margin: 3px 0 0;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.75;
}

.cooperation-partner__intro {
  margin: 16px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}

.cooperation-partner__footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  padding-top: 12px;
  color: var(--ink-muted);
  font-size: 11px;
}

.cooperation-partner__footer > span {
  overflow-wrap: anywhere;
}

.cooperation-partner__link,
.cooperation-partners__footer a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 9px;
  color: var(--accent);
  font-size: 12px;
  transition: transform 120ms ease;
}

.cooperation-partner__link {
  margin-left: 0;
}

.cooperation-partner__link > span {
  transition: transform 120ms ease;
}

.cooperation-partners__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px 16px;
  padding-top: 12px;
  color: var(--ink-muted);
  font-size: 12px;
}

.cooperation-partners--home {
  margin-bottom: 0;
  padding: 0;
  border-bottom: 0;
}
.cooperation-partner__card:active,
.cooperation-partners__footer a:active {
  transform: scale(0.97);
}
.cooperation-partner__card:focus-visible,
.cooperation-partners__footer a:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 4px;
}
@media (hover: hover) {
  .cooperation-partner__card:hover :is(h2, h3) {
    color: var(--accent);
  }
  .cooperation-partner__card:hover .cooperation-partner__link > span {
    transform: translateX(3px);
  }
}
@media (max-width: 1200px) {
  .cooperation-partners__list {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 1000px) {
  .cooperation-partners__list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .cooperation-partners {
    margin-bottom: 32px;
    padding-bottom: 24px;
  }
  .cooperation-partners.cooperation-partners--home {
    margin-bottom: 0;
    padding-bottom: 0;
  }
  .cooperation-partners__list {
    gap: 20px;
    margin-top: 22px;
  }
  .cooperation-partner__avatar {
    height: 72px;
  }
  .cooperation-partner__avatar img {
    max-height: 64px;
  }
  .cooperation-partner :is(h2, h3) {
    font-size: 16px;
  }
  .cooperation-partner__intro {
    font-size: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cooperation-partner__card,
  .cooperation-partner__link,
  .cooperation-partner__link > span,
  .cooperation-partners__footer a {
    transition: none;
    transform: none;
  }
}
</style>
