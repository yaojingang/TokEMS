import assert from 'node:assert/strict';

/** Check the served HTML as well as the saved configuration after a container update. */
export function assertHomepageLogoWall(event, html) {
  const block = event.experience?.home?.blocks?.find((item) => item.nodeKey === 'home.cooperation');
  const wall = block?.content?.logoWall;
  if (!wall) return;
  const expected =
    block.enabled && wall.enabled
      ? wall.items.filter((item) => item.enabled && item.assetId).map((item) => item.assetId)
      : [];
  const section = html.match(/<section\b[^>]*\bid="partner-wall"[^>]*>([\s\S]*?)<\/section>/u)?.[1];
  if (!expected.length) {
    assert.equal(section, undefined, 'Homepage renders a disabled or empty logo wall');
    return;
  }
  assert.ok(section, 'Homepage is missing its configured logo wall');
  const actual = [
    ...section.matchAll(/<img\b[^>]*\bsrc="[^"\s]*\/assets\/templates\/([0-9a-f-]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    actual,
    expected,
    'Served homepage logo images differ from the saved configuration; rebuild the web image',
  );
  assert.match(
    section,
    /<h2\b[^>]*\bid="partner-wall-title"[^>]*>[^<]+<\/h2>/u,
    'Homepage logo wall is missing its section title',
  );
  const logos = section.match(
    /<ul\b[^>]*\bclass="[^"]*\bpartner-wall__logos\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/u,
  )?.[1];
  assert.ok(logos, 'Homepage logo wall is missing its image list');
  assert.equal(
    logos.replace(/<[^>]*>/gu, '').trim(),
    '',
    'Homepage logo list contains visible text beside the images',
  );
}
