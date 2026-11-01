import type { JsonSchema } from './types.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** The input with light coercions applied ("3" → 3 for numbers, "true" → true, "a" → ["a"]). */
  value: unknown;
}

type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

function typesOf(schema: JsonSchema): SchemaType[] {
  const t = schema.type;
  if (Array.isArray(t)) return t as SchemaType[];
  if (typeof t === 'string') return [t as SchemaType];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

function actualType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matches(t: SchemaType, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'null': return v === null;
  }
}

/** Lenient coercions small models need: numeric strings, "true"/"false", scalar → [scalar]. */
function coerce(t: SchemaType, v: unknown): unknown {
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    const n = Number(v);
    return t === 'integer' && !Number.isInteger(n) ? v : n;
  }
  if (t === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (t === 'array' && v != null && !Array.isArray(v) && typeof v !== 'object') return [v];
  if (t === 'object' && typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch {
      /* leave as is */
    }
  }
  return v;
}

/**
 * A deliberately light JSON-Schema check for tool arguments: `type` (incl. unions), `required`,
 * `properties`, `items`, `enum`, `minimum`/`maximum`, `minLength`. Unknown keywords are ignored.
 * Errors are phrased for the model so it can fix its next call.
 */
export function validateArgs(schema: JsonSchema | undefined, value: unknown): ValidationResult {
  const errors: string[] = [];
  const out = check(schema ?? {}, value ?? {}, '', errors);
  return { ok: errors.length === 0, errors, value: out };
}

function check(schema: JsonSchema, v: unknown, path: string, errors: string[]): unknown {
  const where = path || 'arguments';
  const types = typesOf(schema);
  if (types.length && !types.some((t) => matches(t, v))) {
    let fixed: unknown = v;
    for (const t of types) {
      const c = coerce(t, v);
      if (matches(t, c)) {
        fixed = c;
        break;
      }
    }
    if (fixed === v) {
      errors.push(`${where} must be ${types.join(' or ')}, got ${actualType(v)}`);
      return v;
    }
    v = fixed;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === v)) {
    errors.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${where} must be ≥ ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${where} must be ≤ ${schema.maximum}`);
  }
  if (typeof v === 'string' && typeof schema.minLength === 'number' && v.length < schema.minLength) {
    errors.push(`${where} must not be empty`);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = { ...(v as Record<string, unknown>) };
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (obj[req] === undefined || obj[req] === null) errors.push(`missing required ${path ? `${path}.` : ''}${req}`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (obj[k] === undefined) continue;
      // Optional fields sent as null mean "not given" for most models.
      if (obj[k] === null && !typesOf(sub).includes('null')) {
        delete obj[k];
        continue;
      }
      obj[k] = check(sub, obj[k], path ? `${path}.${k}` : k, errors);
    }
    return obj;
  }
  if (Array.isArray(v) && schema.items && typeof schema.items === 'object') {
    return v.map((item, i) => check(schema.items as JsonSchema, item, `${where}[${i}]`, errors));
  }
  return v;
}
