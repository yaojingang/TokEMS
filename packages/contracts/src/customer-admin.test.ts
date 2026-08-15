import { describe, expect, it } from 'vitest';
import {
  CreateCustomerAdminSchema,
  CustomerAdminListQuerySchema,
  CustomerAdminListSchema,
  CustomerAdminSummarySchema,
  UpdateCustomerAdminSchema,
  resolveCustomerAdminDisplay,
} from './index.js';

describe('resolveCustomerAdminDisplay', () => {
  it('uses canonical profile, registration and nickname precedence', () => {
    expect(
      resolveCustomerAdminDisplay(
        { realName: ' 账号姓名 ', nickname: '用户名', company: ' 账号公司 ' },
        { attendeeName: '报名姓名', attendeeCompany: '报名公司' },
      ),
    ).toEqual({
      displayName: '账号姓名',
      displayNameSource: 'profile',
      displayCompany: '账号公司',
      displayCompanySource: 'profile',
    });

    expect(
      resolveCustomerAdminDisplay(
        { realName: ' ', nickname: '用户名', company: '' },
        { attendeeName: ' 报名姓名 ', attendeeCompany: ' 报名公司 ' },
      ),
    ).toEqual({
      displayName: '报名姓名',
      displayNameSource: 'registration',
      displayCompany: '报名公司',
      displayCompanySource: 'registration',
    });

    expect(resolveCustomerAdminDisplay({ nickname: ' 用户名 ' }, null)).toEqual({
      displayName: '用户名',
      displayNameSource: 'nickname',
      displayCompany: '未填写',
      displayCompanySource: 'missing',
    });
  });

  it('uses public numeric IDs and fixed 20-item pages', () => {
    expect(CustomerAdminListQuerySchema.parse({})).toEqual({ page: 1 });
    expect(CustomerAdminListQuerySchema.parse({ page: '3' })).toEqual({ page: 3 });
    expect(CustomerAdminSummarySchema.shape.id.safeParse(101).success).toBe(true);
    expect(
      CustomerAdminSummarySchema.shape.id.safeParse('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').success,
    ).toBe(false);
    expect(
      CustomerAdminListSchema.safeParse({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }).success,
    ).toBe(true);
    expect(
      CustomerAdminListSchema.safeParse({
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      }).success,
    ).toBe(false);
  });

  it('validates administrator-created customer profiles', () => {
    expect(
      CreateCustomerAdminSchema.parse({
        mobile: ' 13800138000 ',
        realName: ' 林晓 ',
        email: 'linxiao@example.com',
      }),
    ).toEqual({
      mobile: '13800138000',
      realName: '林晓',
      email: 'linxiao@example.com',
    });
    expect(CreateCustomerAdminSchema.safeParse({ mobile: '' }).success).toBe(false);
    expect(CreateCustomerAdminSchema.safeParse({ mobile: '12345' }).success).toBe(false);
    expect(
      CreateCustomerAdminSchema.safeParse({
        mobile: '13800138000',
        email: 'invalid-email',
      }).success,
    ).toBe(false);
  });

  it('rejects empty administrator customer updates', () => {
    expect(UpdateCustomerAdminSchema.safeParse({}).success).toBe(false);
    expect(UpdateCustomerAdminSchema.safeParse({ status: 'blocked' }).success).toBe(true);
  });
});
