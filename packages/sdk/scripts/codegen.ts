/**
 * OpenAPI 3.1 → TypeScript: one interface per component schema and one typed method per
 * operation on `InkstoneClient`. Deliberately small (the API's schemas use a known subset of
 * JSON Schema 2020-12: objects, arrays, enums, unions with null, refs), dependency-free, and
 * deterministic, so the committed `src/generated.ts` can be checked for freshness in tests.
 */

type Schema = Record<string, any>;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const prop = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

function doc(text: unknown, indent: string): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  const lines = text.trim().replace(/\*\//g, '*\\/').split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => (l.trim() ? `${indent} * ${l}` : `${indent} *`)).join('\n')}\n${indent} */\n`;
}

/** The TypeScript type for a schema. */
export function tsType(s: Schema | undefined, indent = ''): string {
  if (!s || Object.keys(s).length === 0) return 'unknown';
  if (s.$ref) return String(s.$ref).split('/').pop()!;
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return [...new Set(union.map((x: Schema) => tsType(x, indent)))].join(' | ');
  if (Array.isArray(s.allOf)) return s.allOf.map((x: Schema) => tsType(x, indent)).join(' & ');
  if (Array.isArray(s.type)) return s.type.map((t: string) => tsType({ ...s, type: t }, indent)).join(' | ');
  switch (s.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = tsType(s.items, indent);
      return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case 'object': {
      const props: Record<string, Schema> = s.properties ?? {};
      const required = new Set<string>(s.required ?? []);
      const keys = Object.keys(props);
      const extra = s.additionalProperties && typeof s.additionalProperties === 'object' ? tsType(s.additionalProperties, indent) : null;
      if (!keys.length) return extra ? `Record<string, ${extra}>` : 'Record<string, unknown>';
      const inner = `${indent}  `;
      const lines = keys.map((k) => `${doc(props[k]!.description, inner)}${inner}${prop(k)}${required.has(k) ? '' : '?'}: ${tsType(props[k], inner)};`);
      if (extra) lines.push(`${inner}[key: string]: ${extra} | undefined;`);
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

const camel = (s: string) => s.replace(/[-_](\w)/g, (_m, c: string) => c.toUpperCase());

export function generateSdk(spec: Schema): string {
  const out: string[] = [
    '// Generated from the Inkstone OpenAPI document by packages/sdk/scripts/generate.ts.',
    '// Do not edit: run `npm run generate -w @inkstone/sdk` after changing the API.',
    '/* eslint-disable */',
    "import { BaseClient, type Operation, type RequestOptions } from './runtime.ts';",
    '',
    `/** API version this client was generated for. */`,
    `export const API_VERSION = ${JSON.stringify(spec.info?.version ?? '0.0.0')};`,
    '',
  ];
  const schemas: Record<string, Schema> = spec.components?.schemas ?? {};
  for (const name of Object.keys(schemas).sort()) {
    const s = schemas[name]!;
    const t = tsType(s);
    out.push(doc(s.description, ''));
    out.push(t.startsWith('{') ? `export interface ${name} ${t}\n` : `export type ${name} = ${t};\n`);
  }

  const ops: string[] = [];
  const methods: string[] = [];
  for (const path of Object.keys(spec.paths ?? {}).sort()) {
    for (const method of ['get', 'post', 'patch', 'delete']) {
      const op = spec.paths[path][method];
      if (!op) continue;
      const params: Schema[] = op.parameters ?? [];
      const pathParams = params.filter((p) => p.in === 'path');
      const queryParams = params.filter((p) => p.in === 'query');
      const bodyRef = op.requestBody?.content?.['application/json']?.schema;
      const ok = Object.entries<Schema>(op.responses ?? {}).find(([code]) => /^2\d\d$/.test(code));
      const content = ok?.[1]?.content ?? null;
      let response: 'json' | 'text' | 'bytes' | 'none' = 'none';
      let resultType = 'void';
      if (content?.['application/json']) {
        response = 'json';
        resultType = tsType(content['application/json'].schema);
        if (resultType === 'Record<string, unknown>') resultType = 'Record<string, unknown>';
      } else if (content && Object.keys(content).some((m) => m.startsWith('text/'))) {
        response = 'text';
        resultType = 'string';
      } else if (content && Object.keys(content).length) {
        response = Object.keys(content).some((m) => m === 'image/svg+xml') ? 'text' : 'bytes';
        resultType = response === 'text' ? 'string' : 'Uint8Array';
      }
      // A JSON-or-file export: JSON when asked for json, otherwise text/bytes — expose as unknown.
      if (content && Object.keys(content).length > 1) {
        response = 'bytes';
        resultType = 'Uint8Array';
      }
      if (op.responses?.['304']) resultType = `${resultType} | null`;
      const id = op.operationId as string;
      const opConst = `${camel(id)}Op`;
      ops.push(`const ${opConst}: Operation = ${JSON.stringify({ method: method.toUpperCase(), path, pathParams: pathParams.map((p) => p.name), queryParams: queryParams.map((p) => p.name), hasBody: !!bodyRef, idempotent: params.some((p) => p.name === 'Idempotency-Key'), response })};`);
      const fields = [
        ...pathParams.map((p) => `${doc(p.description, '      ')}      ${prop(p.name)}: ${tsType(p.schema, '      ')};`),
        ...queryParams.map((p) => `${doc(p.description, '      ')}      ${prop(p.name)}${p.required ? '' : '?'}: ${tsType(p.schema, '      ')};`),
        ...(bodyRef ? [`      body: ${tsType(bodyRef)};`] : []),
      ];
      const required = pathParams.length > 0 || !!bodyRef || queryParams.some((p) => p.required);
      const argType = fields.length ? `{\n${fields.join('\n')}\n    }` : 'Record<string, never>';
      const summary = [op.summary, op.description].filter(Boolean).join('\n\n');
      methods.push(
        `${doc(`${summary}\n\n\`${method.toUpperCase()} ${path}\`${op['x-inkstone-scope'] ? ` — scope \`${op['x-inkstone-scope']}\`` : ''}`, '  ')}` +
          `  ${camel(id)}(args${required ? '' : '?'}: ${argType}${required ? '' : ''}, options?: RequestOptions): Promise<${resultType}> {\n` +
          `    return this.request<${resultType}>(${opConst}, args${required ? '' : ' ?? {}'}, options);\n  }\n`,
      );
    }
  }
  out.push(...ops, '');
  out.push('/** Typed client for the Inkstone REST API. Each method is one API operation. */');
  out.push('export class InkstoneClient extends BaseClient {');
  out.push(methods.join('\n'));
  out.push('}', '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
