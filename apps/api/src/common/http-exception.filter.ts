import { InvoiceSmsError } from '@conference/database';
import { redactInvoiceFilePath } from '@conference/security';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    if (/^\/api\/v1\/invoice-files\//.test(request.url)) response.headers({'cache-control':'private, no-store','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow'});
    const traceId = String(request.id ?? crypto.randomUUID());
    const status =
      exception instanceof InvoiceSmsError ? exception.status : exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof InvoiceSmsError ? {message:exception.message,details:exception.details} : exception instanceof HttpException ? exception.getResponse() : undefined;
    const normalized = typeof body === 'object' && body !== null ? body : {};
    const record = normalized as Record<string, unknown>;
    const safePath = redactInvoiceFilePath(request.url);
    if (status >= 500) {
      const detail =
        exception instanceof Error ? (exception.stack ?? exception.message) : exception;
      this.logger.error(`${request.method} ${safePath} failed [${traceId}]`, redactInvoiceFilePath(String(detail)));
    }

    response.status(status).send({
      code: record.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
      message: status >= 500 ? '服务器暂时无法完成请求' : (record.message ?? '请求无法完成'),
      details: status >= 500 ? undefined : record.details,
      traceId,
      path: safePath,
      occurredAt: new Date().toISOString(),
    });
  }
}
