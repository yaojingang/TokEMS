import { Readable } from 'node:stream';
import { Controller, Get, Inject, Module, Param, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvoiceSmsError } from '@conference/database';
import { InvoiceFileService, invoiceByteRange } from '../common/invoice-file.service.js';

@Controller('invoice-files')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class InvoiceFileController {
  constructor(@Inject(InvoiceFileService) private readonly files: InvoiceFileService) {}
  @Get(':token')
  get(@Param('token') token: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.serve(token, request, reply);
  }
  private async serve(token: string, request: FastifyRequest, reply: FastifyReply) {
    reply.headers({
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    let size: number | undefined;
    let streaming = false;
    let fileStream: Readable | undefined;
    try {
      const source = await this.files.resolve(token);
      size = source.size;
      const range = invoiceByteRange(request.headers.range, size);
      const pdf = source.mediaType === 'application/pdf';
      reply.headers({
        'content-type': pdf ? 'application/pdf' : 'application/ofd',
        'accept-ranges': 'bytes',
        'content-disposition': `${pdf ? 'inline' : 'attachment'}; filename="invoice.${pdf ? 'pdf' : 'ofd'}"`,
      });
      if (range)
        reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('content-length', range ? range.end - range.start + 1 : size);
      // Fastify's generated HEAD handler preserves declared size for streams.
      if (request.method === 'HEAD') {
        await this.files.recordAccess(source.link, 'metadata');
        return reply.send(Readable.from([]));
      }
      const { stream } = await this.files.read(token, controller.signal, range);
      fileStream = stream;
      await this.files.recordAccess(source.link, range ? 'partial' : 'opened');
      stream.once('error', () => {
        void this.files.recordAccess(source.link, 'interrupted').catch(() => {});
      });
      streaming = true;
      stream.once('close', () => {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      });
      return reply.send(stream);
    } catch (error) {
      controller.abort();
      fileStream?.destroy();
      const status = error instanceof InvoiceSmsError ? error.status : 503;
      if (status === 416 && size) reply.header('content-range', `bytes */${size}`);
      reply.removeHeader('content-length');
      reply.removeHeader('content-disposition');
      return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>发票领取</title><body><h1>${status === 404 ? '领取链接已失效' : status === 409 ? '发票正在处理中' : status === 416 ? '文件范围无效' : '文件暂时无法读取'}</h1><p>${status === 404 ? '请返回订单页面重新获取发票，或联系主办方。' : '请稍后重试，或返回订单页面下载。'}</p></body></html>`,
        );
    } finally {
      if (!streaming) {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    }
  }
}
@Module({ controllers: [InvoiceFileController], providers: [InvoiceFileService] })
export class InvoiceFileModule {}
