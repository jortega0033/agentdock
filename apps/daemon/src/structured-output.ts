import type { StructuredWorkflowResultV2 } from '@agent-dock/shared';

interface ValidationError { path: string; message: string }
type JsonSchema = Record<string, unknown>;

function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function typeMatches(type: string, value: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validate(schema: JsonSchema, value: unknown, path: string, errors: ValidationError[], depth: number): void {
  if (errors.length >= 1_024 || depth > 16) return;
  if ('const' in schema && !equal(schema.const, value)) errors.push({ path, message: 'does not match const' });
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(item, value))) errors.push({ path, message: 'is not an allowed enum value' });
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === 'string') : [];
  if (types.length && !types.some((type) => typeMatches(type, value))) { errors.push({ path, message: `expected ${types.join(' or ')}` }); return; }
  if (Array.isArray(schema.allOf)) for (const child of schema.allOf) if (child && typeof child === 'object' && !Array.isArray(child)) validate(child as JsonSchema, value, path, errors, depth + 1);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => { if (!child || typeof child !== 'object' || Array.isArray(child)) return false; const local: ValidationError[] = []; validate(child as JsonSchema, value, path, local, depth + 1); return local.length === 0; })) errors.push({ path, message: 'does not match any allowed schema' });
  if (Array.isArray(schema.oneOf)) { const matches = schema.oneOf.filter((child) => { if (!child || typeof child !== 'object' || Array.isArray(child)) return false; const local: ValidationError[] = []; validate(child as JsonSchema, value, path, local, depth + 1); return local.length === 0; }).length; if (matches !== 1) errors.push({ path, message: 'must match exactly one schema' }); }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) value.slice(0, 10_000).forEach((item, index) => validate(schema.items as JsonSchema, item, `${path}/${index}`, errors, depth + 1));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>; const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !(key in object)) errors.push({ path: `${path}/${key}`, message: 'is required' });
    for (const [key, childValue] of Object.entries(object)) { const child = properties[key]; if (child && typeof child === 'object' && !Array.isArray(child)) validate(child as JsonSchema, childValue, `${path}/${key}`, errors, depth + 1); else if (schema.additionalProperties === false) errors.push({ path: `${path}/${key}`, message: 'additional property is not allowed' }); }
  }
}

export function validateStructuredOutput(schema: unknown, output: unknown): StructuredWorkflowResultV2 {
  const errors: ValidationError[] = [];
  validate(schema as JsonSchema, output, '$', errors, 0);
  return { valid: errors.length === 0, normalizedOutput: structuredClone(output), errors };
}
