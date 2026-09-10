import { HttpStatus } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type BatchAttendeeInput,
  type CreateRegistration,
  type RegistrationField,
} from '@conference/contracts';
import { normalizeMainlandMobile } from '@conference/security';
import { DomainError } from './domain-error.js';

export const BATCH_PAYMENT_WINDOW_MS = 15 * 60_000;
export const BATCH_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60_000;

export function batchConflict(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(
    API_ERROR_CODES.INVALID_STATE_TRANSITION,
    message,
    HttpStatus.CONFLICT,
    details,
  );
}

export function batchAmount(unitPrice: number, quantity: number) {
  const amount = unitPrice * quantity;
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 20 ||
    !Number.isInteger(unitPrice) ||
    unitPrice < 0 ||
    !Number.isSafeInteger(amount) ||
    amount > 2147483647
  ) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '购买数量或支付金额超出允许范围',
      HttpStatus.BAD_REQUEST,
    );
  }
  return amount;
}

export function normalizeBatchAttendees(
  inputs: BatchAttendeeInput[],
  loginMobile: string,
  fields: RegistrationField[],
) {
  const seen = new Set<string>();
  const selfMobile = normalizeMainlandMobile(loginMobile);
  const visible = new Set(
    fields.filter((field) => field.enabled !== false).map((field) => field.key),
  );
  const allowed = new Set(fields.map((field) => field.key));
  return inputs.map((input) => {
    const invalid = (field: string, message: string): never => {
      throw new DomainError(API_ERROR_CODES.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, {
        clientId: input.clientId,
        field,
        path: ['attendees', input.clientId, field],
      });
    };
    let mobile: string;
    try {
      mobile = input.isSelf ? selfMobile : normalizeMainlandMobile(input.attendee.mobile);
    } catch {
      return invalid('mobile', '请填写有效的参会人手机号');
    }
    if (!input.isSelf && mobile === selfMobile)
      invalid('mobile', '本人手机号请通过“包含本人参会”添加');
    if (seen.has(mobile)) invalid('mobile', '本次填写的参会人手机号重复');
    seen.add(mobile);
    const attendee: CreateRegistration['attendee'] = { ...input.attendee, mobile };
    for (const key of ['name', 'email', 'company', 'title', 'city'] as const) {
      attendee[key] = visible.has(key) ? attendee[key].trim() : '';
    }
    attendee.email = attendee.email.toLowerCase();
    for (const key of Object.keys(input.formAnswers ?? {})) {
      if (!allowed.has(key)) invalid(key, '报名字段已更新，请核对当前表单');
    }
    const submitted: Record<string, string> = { ...input.formAnswers, ...attendee };
    const formAnswers: Record<string, string> = {};
    for (const field of fields.filter((field) => field.enabled !== false)) {
      const value = String(submitted[field.key] ?? '').trim();
      if (field.required && !value) invalid(field.key, `请填写必填字段：${field.label}`);
      if (value.length > 2000) invalid(field.key, `字段“${field.label}”内容过长`);
      if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        invalid(field.key, `字段“${field.label}”需要有效邮箱`);
      if (value && field.type === 'tel' && (value.length < 7 || value.length > 32))
        invalid(field.key, `字段“${field.label}”需要有效联系电话`);
      if (value && field.type === 'select' && !field.options?.includes(value))
        invalid(field.key, `字段“${field.label}”的选项无效`);
      formAnswers[field.key] = value;
    }
    return {
      ...input,
      attendee,
      formAnswers,
      marketingConsent: input.isSelf && input.marketingConsent,
    };
  });
}
