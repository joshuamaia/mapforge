import { JsonValue } from '../models/json.model';
import { Condition, ConditionOperator } from '../models/mapping.model';
import { getIn, isObject } from '../mapping-engine/path';

/** Falha de conversão: o motor registra o erro e o valor da etapa passa a ser `null`. */
export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export type Value = JsonValue | undefined;

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export const isNil = (v: Value): v is null | undefined => v === null || v === undefined;

export function toText(v: Value): string {
  if (isNil(v)) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Número a partir de number ou string numérica; `null` se não for possível. */
export function looseNumber(v: Value): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && NUMERIC.test(v.trim())) return Number(v.trim());
  return null;
}

export function requireNumber(v: Value, label: string): number {
  const n = looseNumber(v);
  if (n === null) throw new TransformError(`${label}: "${toText(v)}" não é numérico.`);
  return n;
}

/** Ordem: numérica se ambos forem numéricos; caso contrário, por unidade de código. */
export function compareValues(a: Value, b: Value): number {
  const na = looseNumber(a);
  const nb = looseNumber(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = toText(a);
  const sb = toText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  return toText(a) === toText(b);
}

export function isEmptyValue(v: Value): boolean {
  if (isNil(v) || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return isObject(v) && Object.keys(v).length === 0;
}

function asList(v: Value): Value[] {
  if (Array.isArray(v)) return v;
  if (isNil(v)) return [];
  return toText(v)
    .split(',')
    .map((s) => s.trim());
}

export function evaluate(value: Value, operator: ConditionOperator, compare?: Value): boolean {
  switch (operator) {
    case 'eq':
      return valuesEqual(value, compare);
    case 'ne':
      return !valuesEqual(value, compare);
    case 'gt':
      return !isNil(value) && compareValues(value, compare) > 0;
    case 'gte':
      return !isNil(value) && compareValues(value, compare) >= 0;
    case 'lt':
      return !isNil(value) && compareValues(value, compare) < 0;
    case 'lte':
      return !isNil(value) && compareValues(value, compare) <= 0;
    case 'contains':
      if (Array.isArray(value)) return value.some((x) => valuesEqual(x, compare));
      return !isNil(value) && toText(value).includes(toText(compare));
    case 'startsWith':
      return !isNil(value) && toText(value).startsWith(toText(compare));
    case 'endsWith':
      return !isNil(value) && toText(value).endsWith(toText(compare));
    case 'in':
      return asList(compare).some((x) => valuesEqual(value, x));
    case 'notIn':
      return !asList(compare).some((x) => valuesEqual(value, x));
    case 'exists':
      return !isNil(value);
    case 'notExists':
      return isNil(value);
    case 'empty':
      return isEmptyValue(value);
    case 'notEmpty':
      return !isEmptyValue(value);
    case 'matches':
      try {
        return !isNil(value) && new RegExp(toText(compare)).test(toText(value));
      } catch {
        return false;
      }
  }
}

/** Avalia uma condição contra um item (caminho relativo). */
export function evaluateOnItem(item: Value, c: Condition): boolean {
  return evaluate(c.field === '' ? item : getIn(item, c.field), c.operator, c.value);
}

export const OPERATORS: { id: ConditionOperator; label: string; needsValue: boolean }[] = [
  { id: 'eq', label: 'igual a', needsValue: true },
  { id: 'ne', label: 'diferente de', needsValue: true },
  { id: 'gt', label: 'maior que', needsValue: true },
  { id: 'gte', label: 'maior ou igual a', needsValue: true },
  { id: 'lt', label: 'menor que', needsValue: true },
  { id: 'lte', label: 'menor ou igual a', needsValue: true },
  { id: 'contains', label: 'contém', needsValue: true },
  { id: 'startsWith', label: 'começa com', needsValue: true },
  { id: 'endsWith', label: 'termina com', needsValue: true },
  { id: 'in', label: 'está em (lista)', needsValue: true },
  { id: 'notIn', label: 'não está em (lista)', needsValue: true },
  { id: 'exists', label: 'existe', needsValue: false },
  { id: 'notExists', label: 'não existe', needsValue: false },
  { id: 'empty', label: 'está vazio', needsValue: false },
  { id: 'notEmpty', label: 'não está vazio', needsValue: false },
  { id: 'matches', label: 'casa com regex', needsValue: true },
];
