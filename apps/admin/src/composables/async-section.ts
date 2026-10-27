import { ref, shallowRef } from 'vue';

/** Each section publishes its own result and ignores requests from an older context. */
export function createAsyncSection<T>(failureMessage: string) {
  const data = shallowRef<T>();
  const loading = ref(false);
  const error = ref('');
  let requestId = 0;
  let controller: AbortController | undefined;

  function reset() {
    requestId += 1;
    controller?.abort();
    data.value = undefined;
    loading.value = false;
    error.value = '';
  }

  async function load(loader: (signal: AbortSignal) => Promise<T>, clear = false) {
    controller?.abort();
    controller = new AbortController();
    const currentId = ++requestId;
    if (clear) data.value = undefined;
    loading.value = true;
    error.value = '';
    try {
      const result = await loader(controller.signal);
      if (currentId === requestId) {
        data.value = result;
        return result;
      }
    } catch (cause) {
      if (currentId === requestId) {
        error.value = cause instanceof Error ? cause.message : failureMessage;
      }
    } finally {
      if (currentId === requestId) loading.value = false;
    }
  }

  return { data, loading, error, load, reset };
}
