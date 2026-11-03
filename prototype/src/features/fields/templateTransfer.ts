import type { FieldTemplate, FieldTemplateField, FieldType } from '../../model';
import { id } from '../../model';
import { normalizeFieldValidation } from '../../assetValidation';
import { checkedFieldDefinition } from './fieldDefinition';

export const templateFileLimit = 8 * 1024 * 1024;
export type TransferTemplate = Pick<FieldTemplate, 'name' | 'fields'>;
const fieldTypes: FieldType[] = ['text', 'textarea', 'ip', 'integer', 'disk', 'user', 'password', 'boolean', 'date', 'datetime', 'url', 'email', 'phone', 'path'];
const record = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseField(value: unknown, position: string): FieldTemplateField {
  const field = value as FieldTemplateField;
  if (!record(field) || typeof field.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key)
    || typeof field.label !== 'string' || !field.label.trim() || !fieldTypes.includes(field.type)
    || !['required', 'unique', 'showInList', 'systemField'].every(key => typeof field[key as keyof FieldTemplateField] === 'boolean')
    || !['quickCopy', 'readOnly'].every(key => field[key as keyof FieldTemplateField] === undefined || typeof field[key as keyof FieldTemplateField] === 'boolean')
    || field.templateNote !== undefined && typeof field.templateNote !== 'string'
    || !Array.isArray(field.options) || field.options.some(option => typeof option !== 'string')
    || !record(field.validation) || !finite(field.width) || field.width <= 0 || !Number.isInteger(field.sortOrder) || field.sortOrder < 0) {
    throw new Error(`${position}的字段格式无效`);
  }
  let rules: FieldTemplateField['validation'];
  try { rules = normalizeFieldValidation(field.validation); checkedFieldDefinition(field); }
  catch (error) { throw new Error(`${position}的校验规则无效：${error instanceof Error ? error.message : String(error)}`); }
  return {
    key: field.key, label: field.label, type: field.type, templateNote: field.templateNote,
    required: field.required, unique: field.unique, quickCopy: field.quickCopy, defaultValue: field.defaultValue,
    options: [...field.options], validation: { min: rules.min, max: rules.max, maxLength: rules.maxLength, pattern: rules.pattern },
    width: field.width, showInList: field.showInList, sortOrder: field.sortOrder, systemField: field.systemField, readOnly: field.readOnly,
  };
}

export function exportFieldTemplates(templates: TransferTemplate[]) {
  const content = JSON.stringify({ format: 'workbench-field-templates', version: 1, templates: templates.map(template => ({
    name: template.name, fields: template.fields.map((field, index) => parseField(field, `模板“${template.name}”第 ${index + 1} 个字段`)),
  })) }, null, 2);
  if (new TextEncoder().encode(content).byteLength > templateFileLimit) throw new Error('字段模板文件不能超过 8 MB');
  return content;
}

export function parseFieldTemplates(content: string): TransferTemplate[] {
  if (new TextEncoder().encode(content).byteLength > templateFileLimit) throw new Error('字段模板文件不能超过 8 MB');
  let raw;
  try { raw = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('字段模板 JSON 格式无效'); }
  if (!raw || raw.format !== 'workbench-field-templates' || raw.version !== 1 || !Array.isArray(raw.templates) || !raw.templates.length) throw new Error('请选择本应用导出的字段模板 JSON（版本 1）');
  const names = new Set<string>();
  return raw.templates.map((template: TransferTemplate, index: number) => {
    if (!record(template) || typeof template.name !== 'string' || !template.name.trim() || template.name.trim().length > 64 || !Array.isArray(template.fields) || !template.fields.length) throw new Error(`第 ${index + 1} 个模板的名称或字段无效`);
    const name = template.name.trim();
    if (names.has(name)) throw new Error(`文件中的模板名称“${name}”重复`);
    names.add(name);
    const keys = new Set<string>();
    const fields = template.fields.map((value, fieldIndex) => {
      const field = parseField(value, `模板“${name}”第 ${fieldIndex + 1} 个字段`);
      if (keys.has(field.key)) throw new Error(`模板“${name}”的字段键名“${field.key}”重复`);
      keys.add(field.key); return field;
    });
    return { name, fields };
  });
}

export function fieldTemplateImportPlan(existing: FieldTemplate[], incoming: TransferTemplate[], overwrite: boolean) {
  const names = new Set(existing.map(template => template.name));
  const added = incoming.filter(template => !names.has(template.name)).length;
  return { added, updated: overwrite ? incoming.length - added : 0, skipped: overwrite ? 0 : incoming.length - added };
}

export function mergeFieldTemplates(existing: FieldTemplate[], incoming: TransferTemplate[], overwrite: boolean): FieldTemplate[] {
  const templates = [...existing], now = new Date().toISOString();
  for (const template of incoming) {
    const index = templates.findIndex(current => current.name === template.name);
    if (index >= 0 && !overwrite) continue;
    const next = { ...template, id: index >= 0 ? templates[index].id : id(), createdAt: index >= 0 ? templates[index].createdAt : now, updatedAt: now };
    if (index >= 0) templates[index] = next;
    else templates.push(next);
  }
  return templates;
}
