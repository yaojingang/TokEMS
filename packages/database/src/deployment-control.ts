import { chmod, readFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';

type Consumer = { pause: () => Promise<void>; resume: () => void | Promise<void> };

/** Local-only control of background work. HTTP writes are never disabled here. */
export class DeploymentControl {
  private phase: 'active' | 'standby' | 'draining' | 'drained';
  private tasks = new Set<Promise<unknown>>();
  private consumers: Consumer[] = [];
  private generation = 0;
  private drainGeneration = -1;
  private pendingResume: Promise<void> | undefined;
  private ready = false;
  private server?: Server;
  private compatibleHashes = new Set<string>();

  constructor(standby = false) {
    this.phase = standby ? 'standby' : 'active';
  }

  status() {
    return { protocol: 1, phase: this.phase, ready: this.ready, inFlight: this.tasks.size,
      buildSha: process.env.BUILD_SHA ?? 'unknown', compatibleHashes: [...this.compatibleHashes] };
  }

  acceptsMigration(hash: string) { return this.compatibleHashes.has(hash); }

  async track<T>(work: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(work);
    this.tasks.add(promise);
    try { return await promise; } finally { this.tasks.delete(promise); }
  }

  async run(work: () => Promise<unknown>) {
    if (this.phase !== 'active') return;
    await this.track(work);
  }

  register(consumer: Consumer) { this.consumers.push(consumer); }

  async command(command: string) {
    if (command === 'status') return this.status();
    if (command.startsWith('compatible ')) {
      const hashes = command.slice(11).split(',');
      if (hashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) throw new Error('Invalid migration hashes');
      this.compatibleHashes = new Set(hashes);
    } else if (command === 'drain') {
      // A second BullMQ pause() can resolve before the first finishes its active jobs.
      // Repeated commands must keep the original wait until a resume supersedes it.
      if (this.drainGeneration === this.generation) return this.status();
      const generation = ++this.generation;
      this.drainGeneration = generation;
      this.phase = 'draining';
      const pendingResume = this.pendingResume;
      void (async () => {
        // A timed-out resume may still be running. Pause after it settles so it cannot
        // reactivate the consumer after this drain has already completed.
        if (pendingResume) await pendingResume.catch(() => undefined);
        if (this.generation !== generation) return;
        await Promise.all(this.consumers.map((consumer) => consumer.pause()));
        while (this.generation === generation && this.tasks.size) {
          await Promise.allSettled([...this.tasks]);
        }
        if (this.generation === generation) this.phase = 'drained';
      })().catch(() => { /* stay draining: controller must not transfer ownership */ });
    } else if (command === 'activate' || command === 'resume') {
      const generation = ++this.generation;
      const previousResume = this.pendingResume;
      const pendingResume = (async () => {
        if (previousResume) await previousResume.catch(() => undefined);
        const results = await Promise.allSettled(
          this.consumers.map(async (consumer) => consumer.resume()),
        );
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      this.pendingResume = pendingResume;
      try {
        await pendingResume;
        if (this.generation === generation) this.phase = 'active';
      } finally {
        if (this.pendingResume === pendingResume) this.pendingResume = undefined;
      }
    } else {
      throw new Error('Unknown deployment command');
    }
    return this.status();
  }

  async listen(path = process.env.TOKEMS_DEPLOY_CONTROL_SOCKET) {
    this.ready = true;
    if (!path) return;
    if (!path.startsWith('/tmp/')) throw new Error('Deployment socket must be under /tmp');
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    this.server = createServer((socket) => {
      socket.setTimeout(5_000, () => socket.destroy());
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString();
        if (request.length > 8192) { socket.destroy(); return; }
        if (!request.includes('\n')) return;
        socket.removeAllListeners('data');
        void this.command(request.trim()).then(
          (result) => socket.end(`${JSON.stringify(result)}\n`),
          () => socket.end('{"error":"deployment command failed"}\n'),
        );
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(path, resolve);
    });
    await chmod(path, 0o600);
  }

  async close() {
    this.ready = false;
    this.server?.close();
  }
}

function startsInStandby() {
  if (process.env.TOKEMS_DEPLOY_STANDBY !== 'true') return false;
  const path = process.env.TOKEMS_DEPLOY_STATE_FILE;
  if (!path) return true;
  const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!state || typeof state !== 'object') throw new Error('Invalid deployment ownership file');
  return !('sha' in state && state.sha === process.env.BUILD_SHA && 'active' in state && state.active === true);
}

export const deploymentControl = new DeploymentControl(startsInStandby());

// Explicit, release-reviewed forward compatibility survives container restarts.
export async function compatibleMigrationFromFile(hash: string) {
  const path = process.env.TOKEMS_COMPATIBLE_MIGRATIONS_FILE;
  if (!path) return false;
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))
    && value.includes(hash);
}
