import { describe, expect, it } from 'vitest';
import {
  buildAiTemplateBindingProposals,
  compileHtmlTemplate,
  isForbiddenNetworkAddress,
  renderHtmlTemplate,
  rewriteHtmlTemplateResources,
  sanitizeHtmlTemplate,
  suggestTemplateBindings,
  templateAssetIdFromUrl,
} from './index.js';

describe('remote resource network protection', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.51.100.8',
    '203.0.113.7',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '2001:db8::1',
    '2002:7f00:1::',
    'fe80::1%lo0',
  ])('blocks protected address %s', (address) => {
    expect(isForbiddenNetworkAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808'])(
    'allows public address %s',
    (address) => {
      expect(isForbiddenNetworkAddress(address)).toBe(false);
    },
  );
});

describe('template asset URL identity', () => {
  it('accepts only canonical internal template asset URLs', () => {
    const id = '11111111-1111-4111-8111-111111111111';

    expect(templateAssetIdFromUrl(`/api/v1/assets/templates/${id}`)).toBe(id);
    expect(templateAssetIdFromUrl(`/api/v1/assets/templates/${id}?token=forged`)).toBeNull();
    expect(templateAssetIdFromUrl(`/api/v1/assets/templates/${id}/extra`)).toBeNull();
    expect(templateAssetIdFromUrl('https://cdn.example.com/image.png')).toBeNull();
  });
});

describe('sanitizeHtmlTemplate', () => {
  it('removes executable content and assigns deterministic node ids', () => {
    const source = `<!doctype html>
      <html><head><title>TokEMS 大会</title><style>.hero{color:#123}</style></head>
      <body><main class="hero"><h1 onclick="steal()">欢迎参加大会</h1>
      <script>alert(1)</script><a href="/register">立即报名</a></main></body></html>`;

    const first = sanitizeHtmlTemplate(source);
    const second = sanitizeHtmlTemplate(source);

    expect(first.sanitizedHtml).not.toContain('<script');
    expect(first.sanitizedHtml).not.toContain('onclick');
    expect(first.sanitizedHtml).toContain('data-tok-node="tok-00001"');
    expect(first.nodeManifest).toEqual(second.nodeManifest);
    expect(first.sanitizedDigest).toBe(second.sanitizedDigest);
    expect(first.metadata.title).toBe('TokEMS 大会');
    expect(first.securityReport.removedTags).toContain('script');
  });

  it('hardens external links and removes dangerous protocols', () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body>
      <a href="https://example.com/path" target="_blank">外部资料</a>
      <a href="javascript:alert(1)">危险链接</a>
      <a href="http://example.com/plain">明文链接</a>
      <a href="ftp://example.com/file">FTP 链接</a>
      <a href="//example.com/protocol-relative">协议相对链接</a>
    </body></html>`);

    expect(document.sanitizedHtml).toContain('rel="noopener noreferrer"');
    expect(document.sanitizedHtml).not.toContain('javascript:');
    expect(document.sanitizedHtml).not.toContain('http://example.com');
    expect(document.sanitizedHtml).not.toContain('ftp://example.com');
    expect(document.sanitizedHtml).not.toContain('//example.com/protocol-relative');
    expect(document.securityReport.blockers).toContain(
      '检测到不受支持的链接协议，仅允许 HTTPS、mailto、tel 或同源相对地址',
    );
  });

  it('blocks embedded credentials without echoing their values', () => {
    const accessKey = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz.1234567890';
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body><main>
      <div data-api-key="${accessKey}" data-auth="${bearer}">大会页面</div>
    </main></body></html>`);

    expect(document.sanitizedHtml).not.toContain(accessKey);
    expect(document.sanitizedHtml).not.toContain(bearer);
    expect(document.securityReport.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(document.securityReport)).not.toContain(accessKey);
    expect(JSON.stringify(document.securityReport)).not.toContain(bearer);
  });

  it('collects picture srcset resources and reports accessibility gaps', () => {
    const document = sanitizeHtmlTemplate(`<picture>
      <source srcset="https://cdn.example.com/hero.webp 1x, /hero@2x.webp 2x">
      <img src="/hero.png">
    </picture>`);

    expect(document.resourceManifest.map((resource) => resource.url)).toEqual([
      'https://cdn.example.com/hero.webp',
      '/hero@2x.webp',
      '/hero.png',
    ]);
    expect(document.securityReport.warnings).toContain(
      '导入内容是 HTML 片段，系统已补齐标准文档结构',
    );
    expect(document.securityReport.warnings).toContain('1 张图片缺少 alt 文本，建议发布前补充');
  });

  it('removes dangerous CSS declarations and source map comments', () => {
    const sourceMapComment = `source${'MappingURL'}=template.css.map`;
    const document = sanitizeHtmlTemplate(`<!doctype html><html><head><style>
      .safe { color: #123; }
      .legacy { behavior: url(attack.htc); background: url(javascript:alert(1)); }
      /*# ${sourceMapComment} */
    </style></head><body><main><h1>大会</h1></main></body></html>`);

    expect(document.sanitizedHtml).toContain('color: #123');
    expect(document.sanitizedHtml).not.toContain('behavior:');
    expect(document.sanitizedHtml).not.toContain('sourceMappingURL');
    expect(document.securityReport.blockers).toContain('危险 CSS 声明已移除：behavior');
  });

  it('rewrites internalized resources in HTML, nodes, and evidence', () => {
    const sourceUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const document = sanitizeHtmlTemplate(
      `<!doctype html><html><body><img src="${sourceUrl}"></body></html>`,
    );
    const rewritten = rewriteHtmlTemplateResources(document, [
      {
        sourceUrl,
        targetUrl: '/api/v1/assets/templates/11111111-1111-4111-8111-111111111111',
        assetId: '11111111-1111-4111-8111-111111111111',
        mediaType: 'image/png',
        size: 8,
        contentDigest: 'sha256:test',
      },
    ]);

    expect(rewritten.sanitizedHtml).not.toContain(sourceUrl);
    expect(rewritten.nodeManifest.find((node) => node.tagName === 'img')?.attributes.src).toContain(
      '/api/v1/assets/templates/',
    );
    expect(rewritten.resourceManifest[0]?.url).toContain('/api/v1/assets/templates/');
    expect(rewritten.sanitizedDigest).not.toBe(document.sanitizedDigest);
  });

  it('removes reserved TokEMS node attributes before assigning canonical ids', () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><head>
      <style data-tok-node="tok-00001">.hero { color: #123; }</style>
    </head><body><main data-tok-owner="forged"><h1>大会标题</h1></main></body></html>`);

    expect(document.sanitizedHtml.match(/data-tok-node="tok-00001"/gu)).toHaveLength(1);
    expect(document.sanitizedHtml).not.toContain('data-tok-owner');
    expect(document.securityReport.removedAttributes).toContain('data-tok-node');
    expect(document.securityReport.removedAttributes).toContain('data-tok-owner');
  });
});

describe('suggestTemplateBindings', () => {
  it('recognizes a primary title and business navigation without changing copy', () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body><main>
      <h1>第二届中国 GEO &amp; AI 营销大会</h1>
      <p>2026 年 11 月 21–22 日 · 深圳湾科技生态园</p>
      <a href="/register">立即报名</a><a href="/faq">常见问题</a>
    </main></body></html>`);

    const proposals = suggestTemplateBindings(document.nodeManifest);

    expect(
      proposals.some(
        (proposal) =>
          proposal.binding.kind === 'text' &&
          proposal.binding.segments.some(
            (segment) => segment.kind === 'variable' && segment.path === 'event.name',
          ),
      ),
    ).toBe(true);
    expect(
      proposals.some(
        (proposal) =>
          proposal.binding.kind === 'attribute' &&
          proposal.binding.variablePath === 'routes.registration',
      ),
    ).toBe(true);
    expect(proposals.every((proposal) => proposal.source === 'rules')).toBe(true);
  });
});

describe('buildAiTemplateBindingProposals', () => {
  it('keeps AI output inside the node and variable allowlists', () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body>
      <h1>大会标题</h1><a href="/register">立即报名</a>
    </body></html>`);
    const proposals = buildAiTemplateBindingProposals(
      {
        proposals: [
          {
            nodeId: 'tok-00001',
            kind: 'text',
            variablePath: 'event.name',
            confidence: 0.95,
            reason: '标题语义匹配',
          },
          {
            nodeId: 'tok-00002',
            kind: 'attribute',
            variablePath: 'routes.registration',
            confidence: 0.99,
            reason: '报名动作匹配',
          },
          {
            nodeId: 'tok-00001',
            kind: 'text',
            variablePath: 'secrets.apiKey',
            confidence: 1,
            reason: '越界变量',
          },
        ],
      },
      document.nodeManifest,
      '12345678-1234-4123-8123-123456789012',
    );

    expect(proposals).toHaveLength(2);
    expect(proposals.map((proposal) => proposal.operation)).toEqual(['text', 'attribute']);
  });
});

describe('HTML template binding runtime', () => {
  it('keeps imported Liquid delimiters literal through compile and render', async () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body><main>
      <h1 title="{{ event.name }}">{{ event.name }}</h1>
      <p>{% for ticket in tickets %}{{ ticket.name }}{% endfor %}</p>
    </main></body></html>`);
    const compiled = compileHtmlTemplate(document.sanitizedHtml, {
      version: 1,
      bindings: [],
    });
    const html = await renderHtmlTemplate(compiled, {
      event: { name: '不应执行的大会名称' },
      tickets: [{ name: '不应执行的票种' }],
    });

    expect(compiled.liquidSource).not.toContain('{{ event.name }}');
    expect(compiled.liquidSource).not.toContain('{% for ticket');
    expect(html).not.toContain('不应执行的大会名称');
    expect(html).not.toContain('不应执行的票种');
    expect(html).toContain('&#123;&#123; event.name }}');
    expect(html).toContain('&#123;% for ticket in tickets %}');
  });

  it('keeps manually entered static segments literal', async () => {
    const document = sanitizeHtmlTemplate('<main><h1>大会标题</h1></main>');
    const compiled = compileHtmlTemplate(document.sanitizedHtml, {
      version: 1,
      bindings: [
        {
          id: 'literal-static-segment',
          kind: 'text',
          nodeId: 'tok-00002',
          missingPolicy: 'error',
          segments: [
            { kind: 'static', value: '{{ event.shortName }} · ' },
            { kind: 'variable', path: 'event.name', format: 'plain' },
          ],
        },
      ],
    });
    const html = await renderHtmlTemplate(compiled, {
      event: { name: '允许执行的大会名称', shortName: '不应执行的简称' },
    });

    expect(html).toContain('&#123;&#123; event.shortName }} · 允许执行的大会名称');
    expect(html).not.toContain('不应执行的简称');
  });

  it('renders controlled text and route bindings with escaped values', async () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body>
      <main><h1>欢迎参加大会</h1><a href="/register">立即报名</a></main>
    </body></html>`);
    const compiled = compileHtmlTemplate(document.sanitizedHtml, {
      version: 1,
      bindings: [
        {
          id: 'hero-title',
          kind: 'text',
          nodeId: 'tok-00002',
          missingPolicy: 'error',
          segments: [
            { kind: 'static', value: '欢迎参加 ' },
            { kind: 'variable', path: 'event.name', format: 'plain' },
          ],
        },
        {
          id: 'register-link',
          kind: 'attribute',
          nodeId: 'tok-00003',
          attributeName: 'href',
          variablePath: 'routes.registration',
          missingPolicy: 'error',
        },
      ],
    });

    const html = await renderHtmlTemplate(compiled, {
      event: { name: '<img src=x onerror=alert(1)>' },
      routes: { registration: '/register?from=html-template' },
    });

    expect(html).toContain('欢迎参加 &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="/register?from=html-template"');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('{{');
  });

  it('repeats a sample block with collection item fields', async () => {
    const document = sanitizeHtmlTemplate(`<!doctype html><html><body>
      <section><article><h2>标准票</h2><p>剩余 20 张</p></article></section>
    </body></html>`);
    const compiled = compileHtmlTemplate(document.sanitizedHtml, {
      version: 1,
      bindings: [
        {
          id: 'ticket-list',
          kind: 'repeat',
          nodeId: 'tok-00002',
          collectionPath: 'tickets',
          itemAlias: 'ticket',
          emptyPolicy: 'hide',
          children: [
            {
              nodeId: 'tok-00003',
              kind: 'text',
              variablePath: 'tickets[].name',
              format: 'plain',
            },
            {
              nodeId: 'tok-00004',
              kind: 'text',
              variablePath: 'tickets[].remaining',
              format: 'integer',
            },
          ],
        },
      ],
    });

    const html = await renderHtmlTemplate(compiled, {
      tickets: [
        { name: '早鸟票', remaining: 17 },
        { name: '团队票', remaining: 8 },
      ],
    });

    expect(html).toContain('早鸟票');
    expect(html).toContain('团队票');
    expect(html.match(/<article/gu)).toHaveLength(2);
  });
});
