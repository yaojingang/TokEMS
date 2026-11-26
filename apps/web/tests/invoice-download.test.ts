import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as contracts from '@conference/contracts';
import * as presentation from '../app/utils/customer-invoice';

const { descriptor } = parse(
  readFileSync(new URL('../app/pages/account/invoices/[orderId].vue', import.meta.url), 'utf8'),
);
const compiled = compileScript(descriptor, { id: 'invoice-download-test' });
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

interface PageBindings {
  downloadDocument: (id: string) => Promise<void>;
  downloadingId: vue.Ref<string>;
  errorMessage: vue.Ref<string>;
}

function fixture() {
  const document = {
    id: 'document-fixture',
    downloadUrl: '/invoice-files/latest-file-token',
    voidedAt: null as string | null,
  };
  const invoice = vi.fn().mockResolvedValue({ documents: [document] });
  const assign = vi.fn();
  const open = vi.fn<Window['open']>(() => null);
  vi.stubGlobal('window', {
    open,
    location: {
      assign,
      set href(url: string) {
        assign(url);
      },
    },
  });
  const dependencies: Record<string, unknown> = {
    vue,
    '@conference/contracts': contracts,
    '#imports': { useRuntimeConfig: () => ({ public: { apiBase: '/api/v1' } }) },
    '~/composables/useCustomerSession': {
      useCustomerSession: () => ({ invoice, session: vue.ref(null) }),
    },
    '~/utils/customer-invoice': presentation,
  };
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => PageBindings } } };
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    'computed',
    'ref',
    'reactive',
    'onMounted',
    'useRoute',
    'useHead',
    code,
  );
  evaluate(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected page dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    vue.computed,
    vue.ref,
    vue.reactive,
    () => undefined,
    () => ({ params: { orderId: 'order-fixture' } }),
    () => undefined,
  );
  const page = module.exports.default.setup({}, { expose: () => undefined });
  return { page, document, invoice, assign, open };
}

afterEach(() => vi.unstubAllGlobals());

describe('customer invoice file download', () => {
  it('opens the refreshed file in the current web view when new windows are unsupported', async () => {
    const f = fixture();
    f.open.mockImplementation(() => {
      throw new Error('This web view cannot open a new window');
    });
    await expect(f.page.downloadDocument(f.document.id)).resolves.toBeUndefined();
    expect(f.invoice).toHaveBeenCalledWith('order-fixture');
    expect(f.assign).toHaveBeenCalledExactlyOnceWith('/api/v1/invoice-files/latest-file-token');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.page.downloadingId.value).toBe('');
  });

  it('waits for a fresh link before navigating and keeps the loading state while waiting', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.invoice.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const download = f.page.downloadDocument(f.document.id);
    expect(f.page.downloadingId.value).toBe(f.document.id);
    expect(f.assign).not.toHaveBeenCalled();
    resolve({ documents: [{ ...f.document, downloadUrl: 'https://files.example/invoice.pdf' }] });
    await download;
    expect(f.assign).toHaveBeenCalledExactlyOnceWith('https://files.example/invoice.pdf');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.page.downloadingId.value).toBe('');
  });

  it.each(['voided', 'missing', 'no-link'])(
    'keeps an unavailable %s file on the invoice page',
    async (state) => {
      const f = fixture();
      f.invoice.mockResolvedValueOnce({
        documents:
          state === 'missing'
            ? []
            : [
                {
                  ...f.document,
                  ...(state === 'voided'
                    ? { voidedAt: '2026-11-26T00:00:00Z' }
                    : { downloadUrl: null }),
                },
              ],
      });
      await f.page.downloadDocument(f.document.id);
      expect(f.page.errorMessage.value).toBe('当前发票文件已失效，请刷新后重试');
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(f.page.downloadingId.value).toBe('');
    },
  );

  it('reports refresh failures without leaving the page and allows retrying', async () => {
    const f = fixture();
    f.invoice.mockRejectedValueOnce(new Error('发票信息暂时无法读取'));
    await f.page.downloadDocument(f.document.id);
    expect(f.page.errorMessage.value).toBe('发票信息暂时无法读取');
    expect(f.assign).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.page.downloadingId.value).toBe('');
    await f.page.downloadDocument(f.document.id);
    expect(f.page.errorMessage.value).toBe('');
    expect(f.assign).toHaveBeenCalledExactlyOnceWith('/api/v1/invoice-files/latest-file-token');
  });
});
