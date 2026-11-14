import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverOperationArtifact } from './operations.mjs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('interrupted committed operations recover escrow without replaying the mutation', async () => {
  const calls = [];
  const operation = { id: 'committed-operation', status: 'succeeded' };
  const profile = { connectionId: 'connection', dataKey: 'protected' };
  const result = await recoverOperationArtifact(operation, profile, {
    read: async () => { throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' }); },
    request: async (_connection, path, options) => {
      calls.push([path, options?.method || 'GET']);
      return { value: { uploadUrl: 'https://storage.example/private' } };
    },
    save: async (_id, _connection, bytes) => {
      assert.match(bytes.toString(), /uploadUrl/);
      return { available: true, size: bytes.length, sha256: 'protected-digest' };
    },
  });
  assert.equal(result.artifact.available, true);
  assert.equal(result.escrowAcknowledgement, 'acknowledged');
  assert.deepEqual(calls, [
    ['/api/v1/agent/operations/committed-operation/one-time-secret', 'GET'],
    ['/api/v1/agent/operations/committed-operation/one-time-secret/acknowledge', 'POST'],
  ]);
  assert.equal(JSON.stringify(result).includes('storage.example'), false);
});

test('saved protected output survives an acknowledgement retry', async () => {
  const result = await recoverOperationArtifact({ id: 'committed-operation', verificationStatus: 'verified' }, { connectionId: 'connection' }, {
    read: async () => ({ size: 10, sha256: 'digest' }),
    request: async (_connection, path) => {
      assert.ok(path.endsWith('/acknowledge'));
      throw Object.assign(new Error('interrupted'), { code: 'NETWORK_ERROR' });
    },
    save: async () => { throw new Error('Must preserve the existing local artifact'); },
  });
  assert.equal(result.artifact.size, 10);
  assert.equal(result.verification?.status, 'verified');
  assert.match(result.escrowAcknowledgement, /acknowledgement pending/);
});


test('server verification remains authoritative after intentional public removal', async () => {
  if (!vm.SourceTextModule) {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test',
      '--test-name-pattern=server verification remains authoritative', fileURLToPath(import.meta.url)], { encoding: 'utf8', env: childEnvironment });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /pass\s+1/u);
    return;
  }
  const operation = { id: 'operation', status: 'approved', verificationStatus: 'pending' };
  const update = { actionId: 'events.update', method: 'PATCH', path: '/api/v1/admin/events/:eventId',
    verifyActionId: 'events.get', dynamicRiskPolicy: 'published-event-upgrade' };
  const actions = { 'events.update': update,
    'events.get': { method: 'GET', path: '/api/v1/admin/events/:eventId' },
    'organization.settings.get': { method: 'GET', path: '/api/v1/admin/organization' } };
  const mocks = {
    readFile,
    actionDefinition: async (id) => ({ action: actions[id] }),
    actionPath: (action, params) => action.path.replace(':eventId', params.eventId),
    loadProfile: () => ({ connectionId: 'connection', dataKey: 'protected', origin: 'https://events.example.com' }),
    authenticatedFetch: async (_id, path, options) => {
      if (options?.method === 'PATCH') operation.status = 'succeeded';
      if (path.endsWith('/reconcile')) operation.verificationStatus = 'verified';
      if (path.startsWith('/api/v1/agent/operations/')) return { value: { ...operation } };
      return { value: { id: 101, slug: 'demo' }, response: { headers: new Headers({ 'X-Agent-State-Token': 'signed-state' }) } };
    },
    sha256: () => 'digest', stableStringify: JSON.stringify,
    fetchBound: async () => { throw Object.assign(new Error('Hidden event'), { code: 'HTTP_404' }); },
    deletePending: async () => {}, downloadPendingArtifact: async () => {},
    readPending: async () => ({ actionId: 'events.update', params: { eventId: '101' },
      body: { status: 'archived' }, operationRisk: 'controlled' }),
    readPendingArtifact: async () => {}, savePending: async () => {}, savePendingArtifact: async () => {},
    redact: (value) => value,
  };
  const source = await readFile(new URL('./operations.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source);
  await module.link(() => new vm.SyntheticModule(Object.keys(mocks), function () {
    for (const [name, value] of Object.entries(mocks)) this.setExport(name, value);
  }));
  await module.evaluate();
  const result = await module.namespace.executeOperation('operation', 'connection');
  assert.equal(result.operation.verificationStatus, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.evidence.publicDelivery.code, 'HTTP_404');
});
