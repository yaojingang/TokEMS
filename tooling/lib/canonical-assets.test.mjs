import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'tooling/production-deploy.sh'), 'utf8');
const canonicalId = '98b4e830-7431-46bd-9de8-a2c8b05e70cf';
const runtimeId = '4f657579-4ef4-4982-98ad-1c2be44d04f7';
const otherId = '7aa27078-1cc7-4ae4-9a7b-c55bdedd88d4';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function embeddedPython(name) {
  const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?<<'PY'\\n([\\s\\S]*?)\\nPY`));
  assert.ok(match, `${name} Python implementation was not found`);
  return match[1];
}

function runComparison(actual, expected, mode = 'full') {
  const directory = mkdtempSync(resolve(tmpdir(), 'tokems-canonical-assets-'));
  try {
    const files = ['actual', 'expected', 'actual-public', 'expected-public'].map((name) =>
      resolve(directory, `${name}.json`),
    );
    for (const [index, value] of [
      actual,
      expected,
      actual.publicEvent,
      { publicEvent: expected.publicEvent },
    ].entries()) {
      writeFileSync(files[index], JSON.stringify(value ?? {}));
    }
    return spawnSync(
      'python3',
      mode === 'full'
        ? ['-', files[0], files[1]]
        : ['-', files[2], files[3], 'tokems26', files[0], files[1]],
      {
        encoding: 'utf8',
        input: embeddedPython(mode === 'full' ? 'canonical_snapshot_files_match' : 'verify_homepage_file'),
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fixture() {
  const expected = {
    assets: [{
      id: canonicalId,
      contentDigest: sha256('image bytes'),
      contentBase64: Buffer.from('image bytes').toString('base64'),
      storageKey: `templates/${canonicalId}/avatar.png`,
      mediaType: 'image/png',
      size: 11,
    }],
    publicEvent: {
      slug: 'tokems26',
      publicMetrics: {},
      speakers: [{ name: '刘树勋', avatarUrl: `/assets/templates/${canonicalId}` }],
      tickets: [],
    },
    backend: { speakers: [{ avatarAssetId: canonicalId }] },
    release: { snapshot: { speakers: [{ avatarAssetId: canonicalId }] } },
  };
  const actual = JSON.parse(JSON.stringify(expected).replaceAll(canonicalId, runtimeId));
  return { actual, expected };
}

test('full canonical verification accepts real snapshot assets sorted by runtime UUID', () => {
  const expected = JSON.parse(readFileSync(
    resolve(root, 'packages/contracts/src/canonical-homepage.snapshot.json'), 'utf8',
  ));
  assert.ok(expected.assets.length > 1);
  assert.ok(expected.assets.some((asset) => asset.id === canonicalId));
  const actual = JSON.parse(JSON.stringify(expected).replaceAll(canonicalId, runtimeId));
  actual.assets.sort((left, right) => left.id.localeCompare(right.id));
  assert.notEqual(
    actual.assets.findIndex((asset) => asset.id === runtimeId),
    expected.assets.findIndex((asset) => asset.id === canonicalId),
    'fixture must move the deduplicated asset across other asset rows',
  );
  const result = runComparison(actual, expected);
  assert.equal(result.status, 0, result.stderr);
});

for (const mode of ['full', 'public']) {
  test(`${mode} verification accepts a content-identical runtime asset reference`, () => {
    const { actual, expected } = fixture();
    const result = runComparison(actual, expected, mode);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${mode} verification rejects changed speaker content alongside asset remapping`, () => {
    const { actual, expected } = fixture();
    actual.publicEvent.speakers[0].name = '其他嘉宾';
    const result = runComparison(actual, expected, mode);
    assert.equal(result.status, 1, result.stderr);
  });

  test(`${mode} verification rejects a changed asset content digest`, () => {
    const { actual, expected } = fixture();
    actual.assets[0].contentDigest = sha256('different image');
    const result = runComparison(actual, expected, mode);
    assert.equal(result.status, 1, result.stderr);
  });

  test(`${mode} verification preserves unrelated UUIDs in prose and external links`, () => {
    for (const value of [
      `External reference: ${canonicalId}`,
      `https://example.com/profiles/${canonicalId}`,
    ]) {
      const { actual, expected } = fixture();
      expected.publicEvent.description = value;
      actual.publicEvent.description = value.replace(canonicalId, runtimeId);
      const result = runComparison(actual, expected, mode);
      assert.equal(result.status, 1, `${value}: ${result.stderr}`);
    }
  });
}

test('full verification rejects missing or extra assets after remapping', () => {
  for (const mutate of [
    (actual) => { actual.assets = []; },
    (actual) => {
      actual.assets.push({ ...actual.assets[0], id: otherId, contentDigest: sha256('extra') });
    },
  ]) {
    const { actual, expected } = fixture();
    mutate(actual);
    const result = runComparison(actual, expected);
    assert.equal(result.status, 1, result.stderr);
  }
});

test('full verification rejects asset bytes and metadata drift with an unchanged digest', () => {
  for (const update of [
    { contentBase64: Buffer.from('other bytes').toString('base64') },
    { mediaType: 'image/jpeg' },
    { size: 12 },
  ]) {
    const { actual, expected } = fixture();
    Object.assign(actual.assets[0], update);
    const result = runComparison(actual, expected);
    assert.equal(result.status, 1, result.stderr);
  }
});

test('full verification rejects embedded storage-key rewrites outside asset URLs', () => {
  const { actual, expected } = fixture();
  expected.publicEvent.description = `Document path: ${expected.assets[0].storageKey}`;
  actual.publicEvent.description = `Document path: ${actual.assets[0].storageKey}`;
  const result = runComparison(actual, expected);
  assert.equal(result.status, 1, result.stderr);
});

function templateFixture() {
  const { actual, expected } = fixture();
  const definition = {
    image: { assetId: canonicalId, url: `/api/v1/assets/templates/${canonicalId}` },
    title: '大会模板',
  };
  const html = `<img src="/api/v1/assets/templates/${canonicalId}">`;
  expected.template = {
    draft: { definition, contentDigest: sha256(JSON.stringify(definition)) },
    version: { id: 'version-1', definition, contentDigest: sha256(JSON.stringify(definition)) },
    publishedVersions: [{ id: 'version-1', definition, contentDigest: sha256(JSON.stringify(definition)) }],
    htmlDocuments: [{ id: 'document-1', sanitizedHtml: html, sanitizedDigest: sha256(html) }],
  };
  actual.template = JSON.parse(JSON.stringify(expected.template).replaceAll(canonicalId, runtimeId));
  for (const version of [actual.template.draft, actual.template.version, ...actual.template.publishedVersions]) {
    version.contentDigest = sha256(JSON.stringify(version.definition));
  }
  actual.template.htmlDocuments[0].sanitizedDigest = sha256(actual.template.htmlDocuments[0].sanitizedHtml);
  return { actual, expected };
}

test('full verification accepts seed-recomputed template and HTML digests for remapped assets', () => {
  const { actual, expected } = templateFixture();
  assert.notEqual(actual.template.draft.contentDigest, expected.template.draft.contentDigest);
  assert.notEqual(actual.template.htmlDocuments[0].sanitizedDigest, expected.template.htmlDocuments[0].sanitizedDigest);
  const result = runComparison(actual, expected);
  assert.equal(result.status, 0, result.stderr);
});

test('full verification rejects real template content changes despite recomputed digests', () => {
  const { actual, expected } = templateFixture();
  actual.template.draft.definition.title = '其他大会';
  actual.template.draft.contentDigest = sha256(JSON.stringify(actual.template.draft.definition));
  const result = runComparison(actual, expected);
  assert.equal(result.status, 1, result.stderr);
});

test('full verification rejects corrupted derived digests despite matching normalized content', () => {
  const original = templateFixture();
  for (const mutate of [
    (actual) => { actual.template.draft.contentDigest = '0'.repeat(64); },
    (actual) => { actual.template.version.contentDigest = '0'.repeat(64); },
    (actual) => { actual.template.publishedVersions[0].contentDigest = '0'.repeat(64); },
    (actual) => { actual.template.htmlDocuments[0].sanitizedDigest = '0'.repeat(64); },
  ]) {
    const actual = clone(original.actual);
    mutate(actual);
    const result = runComparison(actual, original.expected);
    assert.equal(result.status, 1, result.stderr);
  }
});
