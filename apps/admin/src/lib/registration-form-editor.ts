import {
  CORE_REGISTRATION_FIELDS,
  SYSTEM_REGISTRATION_FIELDS,
  RegistrationFormPublishSchema,
  type RegistrationField,
  type RegistrationFormPublish,
} from '@conference/contracts';

export interface RegistrationFormEditorDraft {
  name: string;
  fields: RegistrationField[];
  termsVersion: string;
  termsContent: string;
}

type PreparedRegistrationForm =
  { ok: true; value: RegistrationFormPublish } | { ok: false; message: string };

export function isCoreRegistrationField(key: string) {
  return CORE_REGISTRATION_FIELDS.some((field) => field.key === key);
}

export function isSystemRegistrationField(key: string) {
  return SYSTEM_REGISTRATION_FIELDS.some((field) => field.key === key);
}

export function nextCustomFieldKey(fields: RegistrationField[]) {
  const keys = new Set(fields.map((field) => field.key.trim()));
  let index = 1;
  while (keys.has(`custom_${index}`)) index += 1;
  return `custom_${index}`;
}

export function prepareRegistrationForm(
  draft: RegistrationFormEditorDraft,
): PreparedRegistrationForm {
  const candidate = {
    name: draft.name.trim(),
    termsVersion: draft.termsVersion.trim(),
    termsContent: draft.termsContent.trim(),
    fields: draft.fields.map((source) => {
      const placeholder = source.placeholder?.trim();
      const options = source.options?.map((item) => item.trim()).filter(Boolean);
      return {
        key: source.key.trim(),
        label: source.label.trim(),
        type: source.type,
        required: source.required,
        ...(source.enabled !== undefined ? { enabled: source.enabled } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(source.type === 'select' && options?.length ? { options } : {}),
      };
    }),
  };
  const result = RegistrationFormPublishSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };

  const issue = result.error.issues[0]!;
  const fieldIndex = typeof issue.path[1] === 'number' ? issue.path[1] : undefined;
  if (fieldIndex === undefined) return { ok: false, message: issue.message };

  const position = `字段 ${fieldIndex + 1}`;
  if (issue.message === '字段键必须唯一') {
    return {
      ok: false,
      message: `字段键“${candidate.fields[fieldIndex]?.key ?? ''}”重复，请修改后再保存`,
    };
  }
  if (issue.message === '选项字段至少需要一个可选值') {
    return { ok: false, message: `${position} 是选项字段，请至少填写一个可选值` };
  }
  if (issue.message === '同一字段的选项必须唯一') {
    return { ok: false, message: `${position} 存在重复的可选值` };
  }
  return {
    ok: false,
    message: issue.message.startsWith('需要')
      ? `${position} ${issue.message}`
      : `${position} 的${issue.message}`,
  };
}
