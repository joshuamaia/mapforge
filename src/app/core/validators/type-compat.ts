import { FieldType } from '../models/schema.model';

/**
 * - `exact`: atribuição direta e segura.
 * - `safe`: conversão implícita sem perda (integer → number).
 * - `lossy`: possível, mas pode falhar ou perder informação (string → number).
 * - `incompatible`: não faz sentido sem uma transformação.
 */
export type Compatibility = 'exact' | 'safe' | 'lossy' | 'incompatible';

const SAFE: Partial<Record<FieldType, FieldType[]>> = {
  integer: ['number', 'string'],
  number: ['string'],
  boolean: ['string'],
  date: ['string', 'datetime'],
  datetime: ['string'],
  enum: ['string'],
};

const LOSSY: Partial<Record<FieldType, FieldType[]>> = {
  number: ['integer'],
  string: ['number', 'integer', 'boolean', 'date', 'datetime', 'enum'],
  datetime: ['date'],
  integer: ['boolean', 'enum'],
};

export function typeCompatibility(source: FieldType, target: FieldType): Compatibility {
  if (source === target) return 'exact';
  if (source === 'any' || target === 'any' || source === 'null') return 'safe';
  if (SAFE[source]?.includes(target)) return 'safe';
  if (LOSSY[source]?.includes(target)) return 'lossy';
  return 'incompatible';
}

export function isCompatible(source: FieldType, target: FieldType): boolean {
  return typeCompatibility(source, target) !== 'incompatible';
}
