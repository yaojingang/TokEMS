import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHomepageLogoWall } from './homepage-logo-wall.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const configuration = (enabled = true) => ({
  experience: {
    home: {
      blocks: [
        {
          nodeKey: 'home.cooperation',
          enabled: true,
          content: { logoWall: { enabled, items: [{ enabled: true, assetId: id }] } },
        },
      ],
    },
  },
});
const image = `<img src="/api/v1/assets/templates/${id}" alt="机构名称">`;
const wall = (content) => `<section id="partner-wall"><ul><li>${content}</li></ul></section>`;

test('accepts real image markup in the configured order', () => {
  assert.doesNotThrow(() => assertHomepageLogoWall(configuration(), wall(image)));
});
test('rejects the stale text grid even when logo configuration is already saved', () => {
  assert.throws(
    () => assertHomepageLogoWall(configuration(), wall('<strong>机构名称</strong>')),
    /rebuild the web image/u,
  );
});
test('rejects missing markup and visible labels beside otherwise valid images', () => {
  assert.throws(() => assertHomepageLogoWall(configuration(), ''), /missing/u);
  assert.throws(
    () => assertHomepageLogoWall(configuration(), wall(`${image}<strong>机构名称</strong>`)),
    /visible text/u,
  );
});
test('requires disabled walls to disappear and tolerates templates without this feature', () => {
  assert.doesNotThrow(() => assertHomepageLogoWall(configuration(false), ''));
  assert.throws(() => assertHomepageLogoWall(configuration(false), wall(image)), /disabled/u);
  assert.doesNotThrow(() => assertHomepageLogoWall({}, '<main>其他模板</main>'));
});
