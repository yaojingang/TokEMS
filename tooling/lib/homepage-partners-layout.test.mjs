import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseForESLint } from 'vue-eslint-parser';

const template = (path) =>
  parseForESLint(readFileSync(new URL(path, import.meta.url), 'utf8'), { parser: false }).ast
    .templateBody;
const attr = (node, name) =>
  node.startTag.attributes.find((item) => !item.directive && item.key.name === name)?.value?.value;
const elements = (node) => node.children.filter((item) => item.type === 'VElement');
const descendants = (node) => elements(node).flatMap((item) => [item, ...descendants(item)]);
const home = template('../../apps/web/app/pages/[[eventSlug]].vue');
const page = elements(home).find((node) => attr(node, 'class')?.split(' ').includes('conference-page'));
const sections = elements(page).filter((node) => node.rawName === 'section');
const orderBinding = (node) =>
  node.startTag.attributes.find(
    (item) =>
      item.directive && item.key.name.name === 'bind' && item.key.argument?.name === 'style',
  )?.value?.expression;

test('every homepage section participates in configured layout ordering', () => {
  assert.ok(sections.length > 10);
  for (const section of sections) {
    const binding = orderBinding(section);
    assert.equal(
      binding?.callee?.name,
      'blockStyle',
      `${attr(section, 'id')} has no section order`,
    );
    assert.ok(binding.arguments[0].value.startsWith('home.'));
  }
});

test('partners follow speakers in DOM order and move with the speakers template block', () => {
  const speakersIndex = sections.findIndex((section) => attr(section, 'id') === 'speakers');
  assert.ok(speakersIndex >= 0);
  const partners = sections[speakersIndex + 1];
  assert.equal(attr(partners, 'id'), 'event-partners');
  assert.equal(orderBinding(partners)?.arguments[0]?.value, 'home.speakers');
});

test('conference pages share the configurable navigation component', () => {
  const componentIn = (tree) => descendants(tree).some((node) => node.rawName === 'ConferenceNavigationLinks');
  assert.ok(componentIn(home));
  assert.ok(componentIn(template('../../apps/web/app/components/EventPublicNav.vue')));
  assert.ok(componentIn(template('../../apps/web/app/pages/apply/cooperation.vue')));
});
