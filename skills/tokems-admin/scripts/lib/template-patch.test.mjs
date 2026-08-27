import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTemplatePatch } from './template-patch.mjs';

function definition() {
  return {
    presentation: {
      kind: 'structured',
      home: {
        seo: { title: '原标题', description: '原描述', shareAssetId: null, indexable: true },
        blocks: [
          {
            nodeKey: 'home.hero',
            type: 'hero',
            label: '首屏',
            enabled: true,
            variant: 'editorial',
            content: { title: '旧文案', subtitle: '保留文案', removable: '删除我' },
          },
          {
            nodeKey: 'home.cooperation',
            type: 'cooperation',
            label: '合作',
            enabled: true,
            variant: 'default',
            content: { title: '合作标题' },
          },
          {
            nodeKey: 'home.tickets',
            type: 'tickets',
            label: '票务',
            enabled: true,
            variant: 'default',
            content: { title: '票务标题' },
          },
        ],
      },
    },
    faq: {
      mode: 'home',
      title: 'FAQ',
      introduction: '',
      searchEnabled: true,
      contactLabel: '',
      contactUrl: '',
      items: [
        {
          nodeKey: 'faq.ticket',
          category: '票务',
          question: '旧问题',
          answer: '旧答案',
          enabled: true,
        },
      ],
    },
    registrationFlow: {
      preset: 'standard-paid',
      progressVariant: 'steps',
      summaryCardEnabled: true,
      branches: {},
      steps: [
        {
          nodeKey: 'flow.attendee-form',
          type: 'attendee-form',
          title: '参会资料',
          helpText: '原提示',
          variant: 'default',
          enabled: true,
        },
        {
          nodeKey: 'flow.success-ticket',
          type: 'success-ticket',
          title: '报名成功',
          helpText: '',
          variant: 'default',
          enabled: true,
        },
      ],
    },
    initialization: { copyPolicy: {} },
  };
}

test('template patch preserves unspecified fields and deletes null content keys', () => {
  const original = definition();
  const patched = applyTemplatePatch(original, {
    seo: { title: '新标题' },
    homeBlocks: [
      {
        nodeKey: 'home.hero',
        content: { title: '新文案', removable: null },
      },
    ],
  });

  assert.equal(patched.presentation.home.seo.title, '新标题');
  assert.equal(patched.presentation.home.seo.description, '原描述');
  assert.deepEqual(patched.presentation.home.blocks[0].content, {
    title: '新文案',
    subtitle: '保留文案',
  });
  assert.equal(original.presentation.home.blocks[0].content.removable, '删除我');
});

test('template patch requires a complete unique home order', () => {
  const patched = applyTemplatePatch(definition(), {
    homeOrder: ['home.tickets', 'home.hero', 'home.cooperation'],
  });
  assert.deepEqual(
    patched.presentation.home.blocks.map((block) => block.nodeKey),
    ['home.tickets', 'home.hero', 'home.cooperation'],
  );
  assert.throws(
    () => applyTemplatePatch(definition(), { homeOrder: ['home.hero', 'home.tickets'] }),
    { code: 'TEMPLATE_PATCH_INCOMPLETE_ORDER' },
  );
  assert.throws(
    () =>
      applyTemplatePatch(definition(), {
        homeOrder: ['home.hero', 'home.hero', 'home.cooperation'],
      }),
    { code: 'TEMPLATE_PATCH_DUPLICATE_NODE' },
  );
});

test('template patch updates flow and upserts or removes FAQ nodes', () => {
  const patched = applyTemplatePatch(definition(), {
    flowSteps: [{ nodeKey: 'flow.attendee-form', helpText: '请填写真实资料' }],
    faqItems: [
      { nodeKey: 'faq.ticket', operation: 'upsert', answer: '新答案' },
      {
        nodeKey: 'faq.venue',
        operation: 'upsert',
        category: '会场',
        question: '在哪里举办？',
        answer: '深圳。',
        enabled: true,
      },
    ],
  });
  assert.equal(patched.registrationFlow.steps[0].helpText, '请填写真实资料');
  assert.equal(patched.faq.items[0].answer, '新答案');
  assert.equal(patched.faq.items[1].nodeKey, 'faq.venue');

  const removed = applyTemplatePatch(patched, {
    faqItems: [{ nodeKey: 'faq.ticket', operation: 'remove' }],
  });
  assert.deepEqual(
    removed.faq.items.map((item) => item.nodeKey),
    ['faq.venue'],
  );
});

test('template patch stores ordered organization groups including explicit empty groups', () => {
  const groups = [
    {
      key: 'media',
      label: '媒体伙伴',
      meta: 'MEDIA NETWORK',
      organizations: ['媒体甲'],
    },
    {
      key: 'speaker',
      label: '嘉宾机构',
      meta: 'SPEAKER NETWORK',
      organizations: [],
    },
  ];
  const patched = applyTemplatePatch(definition(), { organizationGroups: groups });
  assert.deepEqual(patched.presentation.home.blocks[1].content.organizationGroups, groups);
});

test('template patch rejects unknown and duplicate nodes', () => {
  assert.throws(
    () =>
      applyTemplatePatch(definition(), {
        homeBlocks: [{ nodeKey: 'home.unknown', content: { title: '不可写入' } }],
      }),
    { code: 'TEMPLATE_PATCH_UNKNOWN_NODE' },
  );
  assert.throws(
    () =>
      applyTemplatePatch(definition(), {
        flowSteps: [
          { nodeKey: 'flow.attendee-form', enabled: true },
          { nodeKey: 'flow.attendee-form', enabled: false },
        ],
      }),
    { code: 'TEMPLATE_PATCH_DUPLICATE_NODE' },
  );
  assert.throws(
    () =>
      applyTemplatePatch(definition(), {
        faqItems: [
          { nodeKey: 'faq.ticket', operation: 'remove' },
          { nodeKey: 'faq.ticket', operation: 'upsert', answer: '冲突' },
        ],
      }),
    { code: 'TEMPLATE_PATCH_DUPLICATE_NODE' },
  );
});

test('template patch rejects prototype-bearing content keys at any depth', () => {
  const unsafe = JSON.parse(
    '{"homeBlocks":[{"nodeKey":"home.hero","content":{"nested":{"__proto__":{"polluted":true}}}}]}',
  );
  assert.throws(() => applyTemplatePatch(definition(), unsafe), {
    code: 'TEMPLATE_PATCH_UNSAFE_KEY',
  });
  assert.equal({}.polluted, undefined);
});
