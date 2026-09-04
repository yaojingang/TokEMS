import { describe, expect, it } from 'vitest';
import { SYSTEM_REGISTRATION_FIELDS, type RegistrationField } from '@conference/contracts';
import { nextCustomFieldKey, prepareRegistrationForm } from './registration-form-editor.js';

function standardFields(): RegistrationField[] {
  return [
    ...SYSTEM_REGISTRATION_FIELDS.map((field) => ({ ...field, required: true })),
    { key: 'company', label: '公司/机构', type: 'text', required: true },
    { key: 'title', label: '职位', type: 'text', required: true },
    { key: 'city', label: '所在城市', type: 'text', required: true },
  ];
}

function draft(fields = standardFields()) {
  return {
    name: '标准参会报名表',
    fields,
    termsVersion: '2026-08-04',
    termsContent: '提交报名即表示同意大会报名条款与个人信息处理说明。',
  };
}

describe('registration form editor', () => {
  it('keeps contact fields compatible with the registration and payment flow', () => {
    const fields = standardFields();
    fields[1] = { ...fields[1]!, required: false };

    expect(prepareRegistrationForm(draft(fields))).toEqual({
      ok: false,
      message: '手机号码是系统核心字段，需保留键名 mobile、tel 类型，保持开启并设为必填',
    });
  });

  it('allows profile fields to become optional or be removed', () => {
    const fields = standardFields()
      .filter((field) => field.key !== 'title' && field.key !== 'city')
      .map((field) => (field.key === 'company' ? { ...field, required: false } : field));

    expect(prepareRegistrationForm(draft(fields))).toMatchObject({
      ok: true,
      value: {
        fields: expect.arrayContaining([
          { key: 'company', label: '公司/机构', type: 'text', required: false },
        ]),
      },
    });
  });

  it('returns a specific message for duplicate keys and empty select options', () => {
    const duplicated = [...standardFields(), { ...standardFields()[0]!, label: '称呼' }];
    expect(prepareRegistrationForm(draft(duplicated))).toEqual({
      ok: false,
      message: '字段键“name”重复，请修改后再保存',
    });

    const withoutOptions = [
      ...standardFields(),
      { key: 'industry', label: '行业', type: 'select', required: false } as const,
    ];
    expect(prepareRegistrationForm(draft(withoutOptions))).toEqual({
      ok: false,
      message: '字段 7 是选项字段，请至少填写一个可选值',
    });
  });

  it('normalizes editable copy and creates collision-free custom keys', () => {
    const fields = [
      ...standardFields(),
      { key: 'custom_1', label: '  参会目的  ', type: 'text', required: false } as const,
      { key: 'custom_3', label: '补充信息', type: 'text', required: false } as const,
    ];

    expect(nextCustomFieldKey(fields)).toBe('custom_2');
    expect(prepareRegistrationForm(draft(fields))).toMatchObject({
      ok: true,
      value: {
        fields: expect.arrayContaining([
          { key: 'custom_1', label: '参会目的', type: 'text', required: false },
        ]),
      },
    });
  });
});
