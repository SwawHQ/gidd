import { parseDocument } from './vendor/yaml.mjs';

export const specLanguages = Object.freeze(['en', 'zh-CN']);
export const invalidSpecResource = () => { throw new Error('spec_resources_invalid'); };
export const nonemptyText = value => typeof value === 'string' && !!value.trim();
export const stringList = (value, min = 1, max = 100) => Array.isArray(value) && value.length >= min &&
  value.length <= max && value.every(nonemptyText);
export function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalidSpecResource();
}

export function parseSpecYaml(text) {
  const document = parseDocument(text, { version: '1.2', schema: 'core', strict: true,
    uniqueKeys: true, stringKeys: true, resolveKnownTags: false });
  // Inspect diagnostics ourselves: resource errors must not leak parser warnings
  // onto the CLI streams. Specs use one YAML 1.2 document without aliases.
  if (document.errors.length || document.warnings.length || document.directives.yaml.version !== '1.2') invalidSpecResource();
  return document.toJS({ maxAliasCount: 0 });
}

// Validate shipped form resources without evaluating Issue bodies.
export function validateIssueForms(forms) {
  const invalid = invalidSpecResource;
  fields(forms, specLanguages);
  const names = new Set();
  let shape;
  for (const lang of specLanguages) {
    const form = forms[lang];
    fields(form, ['name', 'description', 'body'], ['title', 'labels', 'assignees', 'projects', 'type']);
    if (!nonemptyText(form.name) || form.name.trim().length <= 3 || names.has(form.name) ||
        !nonemptyText(form.description) || !Array.isArray(form.body) || !form.body.length || form.body.length > 32) invalid();
    names.add(form.name);
    for (const key of ['title', 'type']) if (Object.hasOwn(form, key) && !nonemptyText(form[key])) invalid();
    for (const key of ['labels', 'assignees', 'projects']) {
      if (Object.hasOwn(form, key) && !stringList(form[key], 0)) invalid();
    }
    const ids = new Set(), labels = new Set(), currentShape = [];
    for (const item of form.body) {
      if (item?.type === 'markdown') {
        fields(item, ['type', 'attributes']); fields(item.attributes, ['value']);
        if (!nonemptyText(item.attributes.value)) invalid();
        currentShape.push({ type: 'markdown' });
        continue;
      }
      fields(item, ['type', 'id', 'attributes'], ['validations']);
      if (!['textarea', 'input'].includes(item.type) || typeof item.id !== 'string' ||
          !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) invalid();
      ids.add(item.id);
      fields(item.attributes, ['label'], ['description', 'placeholder', 'value', ...(item.type === 'textarea' ? ['render'] : [])]);
      const attributes = item.attributes;
      if (Object.values(attributes).some(value => typeof value !== 'string') ||
          !nonemptyText(attributes.label) || /[\r\n]/.test(attributes.label)) invalid();
      const label = attributes.label.trim().toLowerCase();
      if (labels.has(label)) invalid();
      labels.add(label);
      if (Object.hasOwn(item, 'validations')) {
        fields(item.validations, [], ['required']);
        if (Object.hasOwn(item.validations, 'required') && typeof item.validations.required !== 'boolean') invalid();
      }
      const required = item.validations?.required ?? false;
      currentShape.push({ id: item.id, type: item.type, required, render: attributes.render });
    }
    if (!ids.size || !form.body.some(item => item.validations?.required)) invalid();
    if (shape && JSON.stringify(shape) !== JSON.stringify(currentShape)) invalid();
    shape = currentShape;
  }
  return forms;
}
