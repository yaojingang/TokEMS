import { describe, expect, it } from 'vitest';
import { DeploymentControl } from './deployment-control.js';

describe('background ownership', () => {
  it('standby performs no startup work and activates explicitly', async () => {
    const control = new DeploymentControl(true);
    let writes = 0;
    await control.run(async () => { writes++; });
    expect(writes).toBe(0);
    await control.command('activate');
    await control.run(async () => { writes++; });
    expect(writes).toBe(1);
  });
  it('drains in-flight work, skips new work and permits timeout recovery', async () => {
    const control = new DeploymentControl();
    let finish!: () => void;
    const running = control.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    await control.command('drain');
    let started = false;
    await control.run(async () => { started = true; });
    expect(started).toBe(false);
    expect(control.status().phase).toBe('draining');
    await control.command('resume');
    finish();
    await running;
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('active');
    await control.command('drain');
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('drained');
  });

  it('repeated drain keeps waiting for the original consumer pause after its processor has finished', async () => {
    const control = new DeploymentControl();
    let finishConsumer!: () => void;
    let pauseCalls = 0;
    const consumerFinished = new Promise<void>((resolve) => { finishConsumer = resolve; });
    control.register({
      // BullMQ marks itself paused before awaiting job bookkeeping; another pause returns immediately.
      pause: () => ++pauseCalls === 1 ? consumerFinished : Promise.resolve(),
      resume: async () => undefined,
    });
    await control.command('drain');
    await control.command('drain');
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('draining');
    expect(pauseCalls).toBe(1);
    finishConsumer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('drained');
  });

  it('drain after resume starts a new pause and ignores completion of the previous drain', async () => {
    const control = new DeploymentControl();
    const finish: Array<() => void> = [];
    control.register({
      pause: () => new Promise<void>((resolve) => { finish.push(resolve); }),
      resume: async () => undefined,
    });
    await control.command('drain');
    await control.command('resume');
    await control.command('drain');
    expect(finish).toHaveLength(2);
    finish[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('draining');
    finish[1]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(control.status().phase).toBe('drained');
  });

  it('drain waits for an unfinished resume before pausing the consumer again', async () => {
    const control = new DeploymentControl(true);
    let finishResume!: () => void;
    let consumerActive = false;
    let pauseCalls = 0;
    control.register({
      pause: async () => { pauseCalls++; consumerActive = false; },
      resume: () => new Promise<void>((resolve) => {
        finishResume = () => { consumerActive = true; resolve(); };
      }),
    });
    const resuming = control.command('resume');
    await control.command('drain');
    expect(pauseCalls).toBe(0);
    finishResume();
    await resuming;
    await new Promise((resolve) => setImmediate(resolve));
    expect(pauseCalls).toBe(1);
    expect(consumerActive).toBe(false);
    expect(control.status().phase).toBe('drained');
  });

  it('a newer resume supersedes a drain still waiting for an earlier resume', async () => {
    const control = new DeploymentControl(true);
    const finish: Array<() => void> = [];
    let pauseCalls = 0;
    control.register({
      pause: async () => { pauseCalls++; },
      resume: () => new Promise<void>((resolve) => { finish.push(resolve); }),
    });
    const first = control.command('resume');
    await control.command('drain');
    const last = control.command('resume');
    finish[0]!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveLength(2);
    finish[1]!();
    await last;
    expect(pauseCalls).toBe(0);
    expect(control.status().phase).toBe('active');
  });

  it('drains all consumers after a partially failed resume has settled', async () => {
    const control = new DeploymentControl(true);
    let finishResume!: () => void;
    let consumerActive = false;
    let pauseCalls = 0;
    control.register({
      pause: async () => { pauseCalls++; },
      resume: () => { throw new Error('consumer unavailable'); },
    });
    control.register({
      pause: async () => { pauseCalls++; consumerActive = false; },
      resume: () => new Promise<void>((resolve) => {
        finishResume = () => { consumerActive = true; resolve(); };
      }),
    });
    const resuming = control.command('resume').catch((error: unknown) => error);
    await control.command('drain');
    await new Promise((resolve) => setImmediate(resolve));
    expect(pauseCalls).toBe(0);
    finishResume();
    expect(await resuming).toEqual(new Error('consumer unavailable'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(pauseCalls).toBe(2);
    expect(consumerActive).toBe(false);
    expect(control.status().phase).toBe('drained');
  });
});
