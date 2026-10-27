import { describe, expect, it } from 'vitest';
import { createAsyncSection } from './async-section';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('independent asynchronous sections', () => {
  it('publishes a ready section while a sibling is still loading', async () => {
    const first = createAsyncSection<number>('读取失败');
    const second = createAsyncSection<number>('读取失败');
    const waiting = deferred<number>();
    const pending = second.load(() => waiting.promise);
    await first.load(async () => 12);
    expect(first.data.value).toBe(12);
    expect(second.loading.value).toBe(true);
    expect(second.data.value).toBeUndefined();
    waiting.resolve(0);
    await pending;
    expect(second.data.value).toBe(0);
  });

  it('keeps a previous result on refresh failure and recovers on retry', async () => {
    const section = createAsyncSection<number>('读取失败');
    await section.load(async () => 18);
    await section.load(async () => {
      throw new Error('网络异常');
    });
    expect(section.data.value).toBe(18);
    expect(section.error.value).toBe('网络异常');
    await section.load(async () => 19);
    expect(section.data.value).toBe(19);
    expect(section.error.value).toBe('');
  });

  it('aborts old requests and rejects late results after changing context', async () => {
    const section = createAsyncSection<number>('读取失败');
    const old = deferred<number>();
    let oldSignal: AbortSignal | undefined;
    const pending = section.load((signal) => {
      oldSignal = signal;
      return old.promise;
    });
    section.reset();
    await section.load(async () => 22);
    old.resolve(11);
    await pending;
    expect(oldSignal?.aborted).toBe(true);
    expect(section.data.value).toBe(22);
    expect(section.loading.value).toBe(false);
  });

  it('clears a previous query immediately and ignores its late failure', async () => {
    const section = createAsyncSection<number>('读取失败');
    await section.load(async () => 10);
    const old = deferred<number>();
    const pending = section.load(() => old.promise);
    const next = deferred<number>();
    const nextPending = section.load(() => next.promise, true);
    expect(section.data.value).toBeUndefined();
    old.reject(new Error('旧查询失败'));
    await pending;
    expect(section.error.value).toBe('');
    expect(section.loading.value).toBe(true);
    next.resolve(2);
    await nextPending;
    expect(section.data.value).toBe(2);
  });
});
