import { JsonValue } from '../models/json.model';
import { FieldNode, FieldType, ParseIssue, ParseResult } from '../models/schema.model';
import { childPath, isObject } from '../mapping-engine/path';
import { parseIsoDate } from '../transformations/date-utils';

export interface ParseLimits {
  maxBytes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: ParseLimits = { maxBytes: 5 * 1024 * 1024, maxDepth: 32 };

/** Quantidade máxima de itens de um array analisados para inferir o tipo do elemento. */
const ARRAY_SAMPLE = 500;

export type JsonParseOutcome =
  | { ok: true; value: JsonValue }
  | { ok: false; message: string; line?: number; column?: number; kind: 'syntax' | 'limit' };

export function byteSize(text: string): number {
  return new Blob([text]).size;
}

export function parseJsonSafe(
  text: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): JsonParseOutcome {
  if (text.length > limits.maxBytes || byteSize(text) > limits.maxBytes) {
    return {
      ok: false,
      kind: 'limit',
      message: `O conteúdo excede o limite de ${formatBytes(limits.maxBytes)}. Ajuste em Settings, se necessário.`,
    };
  }
  if (text.trim() === '')
    return { ok: false, kind: 'syntax', message: 'O conteúdo JSON está vazio.' };
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (e) {
    return { ok: false, kind: 'syntax', ...describeJsonError(e as Error, text) };
  }
  const depth = jsonDepth(value, limits.maxDepth + 1);
  if (depth > limits.maxDepth) {
    return {
      ok: false,
      kind: 'limit',
      message: `A profundidade do JSON excede o limite de ${limits.maxDepth} níveis.`,
    };
  }
  return { ok: true, value };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function describeJsonError(
  e: Error,
  text: string,
): { message: string; line?: number; column?: number } {
  const offset = locateJsonError(text);
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return {
    message: `JSON inválido: ${e.message}`,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/**
 * Posição do primeiro erro. Nem todo motor JavaScript informa a posição na mensagem de
 * `JSON.parse`, então o texto é percorrido por um pequeno scanner, usado só em caso de falha.
 */
export function locateJsonError(text: string): number {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
  };
  class Stop extends Error {}
  const stop = (): never => {
    throw new Stop();
  };
  const scanString = (): void => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') stop();
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) stop();
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') stop();
        scanString();
        ws();
        if (text[i] !== ':') stop();
        i++;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        stop();
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        stop();
      }
    } else if (c === '"') {
      scanString();
    } else {
      const m = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
      if (!m) stop();
      i += (m as RegExpExecArray)[0].length;
    }
  };
  try {
    value();
    ws();
  } catch (e) {
    if (!(e instanceof Stop) && !(e instanceof RangeError)) throw e;
  }
  return Math.min(i, text.length);
}

/** Profundidade limitada: interrompe ao passar de `stopAt`, sem percorrer o restante. */
function jsonDepth(value: JsonValue, stopAt: number): number {
  let max = 0;
  const stack: { v: JsonValue; d: number }[] = [{ v: value, d: 1 }];
  while (stack.length) {
    const { v, d } = stack.pop() as { v: JsonValue; d: number };
    if (v === null || typeof v !== 'object') continue;
    if (d > max) max = d;
    if (max >= stopAt) return max;
    const children = Array.isArray(v) ? v : Object.values(v);
    for (const c of children)
      if (typeof c === 'object' && c !== null) stack.push({ v: c, d: d + 1 });
  }
  return max;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function inferScalarType(value: JsonValue): FieldType {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      if (ISO_DATE.test(value)) return parseIsoDate(value) ? 'date' : 'string';
      if (ISO_DATETIME.test(value)) return parseIsoDate(value) ? 'datetime' : 'string';
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    default:
      return Array.isArray(value) ? 'array' : 'object';
  }
}

function mergeTypes(a: FieldType, b: FieldType): FieldType {
  if (a === b) return a;
  if (a === 'null') return b;
  if (b === 'null') return a;
  const numeric = new Set<FieldType>(['integer', 'number']);
  if (numeric.has(a) && numeric.has(b)) return 'number';
  const temporal = new Set<FieldType>(['date', 'datetime']);
  if (temporal.has(a) && temporal.has(b)) return 'datetime';
  const textual = new Set<FieldType>(['string', 'date', 'datetime']);
  if (textual.has(a) && textual.has(b)) return 'string';
  return 'any';
}

/** Infere a árvore de campos de um valor. Itens de um array são combinados em um único schema. */
export function inferSchema(value: JsonValue, rootName = 'root'): FieldNode {
  return inferNode(rootName, '', [value], true);
}

function inferNode(name: string, path: string, values: JsonValue[], isRoot = false): FieldNode {
  let type: FieldType = 'null';
  let nullable = false;
  for (const v of values) {
    if (v === null) nullable = true;
    type = mergeTypes(type, inferScalarType(v));
  }
  const node: FieldNode = { name, path, type, required: false };
  if (nullable && !isRoot) node.nullable = true;
  const sample = values.find((v) => v !== null && typeof v !== 'object');
  if (sample !== undefined) node.sample = sample;

  if (type === 'object') {
    const objects = values.filter(isObject);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        if (!seen.has(key) && key !== '__proto__') {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    node.children = keys.map((key) =>
      inferNode(
        key,
        childPath(path, key),
        objects.filter((o) => Object.prototype.hasOwnProperty.call(o, key)).map((o) => o[key]),
      ),
    );
  } else if (type === 'array') {
    const items: JsonValue[] = [];
    for (const v of values) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (items.length >= ARRAY_SAMPLE) break;
          items.push(item);
        }
      }
    }
    const itemPath = `${path}[*]`;
    if (items.length === 0) {
      node.itemType = 'any';
    } else {
      const item = inferNode('[*]', itemPath, items);
      node.itemType = item.type;
      node.children = item.type === 'object' ? item.children : [item];
    }
  }
  return node;
}

export function parseJsonStructure(
  text: string,
  rootName: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): ParseResult {
  const outcome = parseJsonSafe(text, limits);
  if (!outcome.ok) {
    const issue: ParseIssue = {
      severity: 'error',
      message: outcome.message,
      line: outcome.line,
      column: outcome.column,
      kind: outcome.kind,
    };
    return { root: null, rootName, issues: [issue] };
  }
  return { root: inferSchema(outcome.value, rootName), rootName, issues: [] };
}
