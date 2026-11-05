import { JsonValue } from '../models/json.model';

/**
 * Sintaxe de caminhos do MapForge:
 *   cliente.nome            propriedades aninhadas
 *   pedidos[*].codigo       iteração sobre todos os itens
 *   pedidos[0].codigo       item específico (somente leitura)
 *   matriz[*][*]            arrays aninhados
 *   dados["chave com ponto.e espaço"]  chaves arbitrárias
 */
export type PathSegment =
  { kind: 'prop'; name: string } | { kind: 'wildcard' } | { kind: 'index'; index: number };

export class PathSyntaxError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'PathSyntaxError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SIMPLE_KEY = /^[A-Za-z_$][\w$-]*$/;
const cache = new Map<string, PathSegment[]>();

export function parsePath(path: string): PathSegment[] {
  const cached = cache.get(path);
  if (cached) return cached;
  const segments = parseUncached(path);
  if (cache.size > 5000) cache.clear();
  cache.set(path, segments);
  return segments;
}

function parseUncached(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  let expectKey = false;
  const fail = (why: string): never => {
    throw new PathSyntaxError(`Caminho inválido "${path}": ${why} (posição ${i}).`, path);
  };
  const addProp = (name: string): void => {
    if (FORBIDDEN_KEYS.has(name)) fail(`a chave "${name}" não é permitida`);
    segments.push({ kind: 'prop', name });
  };

  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      if (expectKey || segments.length === 0) fail('ponto inesperado');
      expectKey = true;
      i++;
    } else if (ch === '[') {
      if (expectKey) fail('colchete inesperado após ponto');
      if (path[i + 1] === '"') {
        let j = i + 2;
        let name = '';
        while (j < path.length && path[j] !== '"') {
          if (path[j] === '\\' && j + 1 < path.length) j++;
          name += path[j];
          j++;
        }
        if (path[j] !== '"' || path[j + 1] !== ']') fail('chave entre aspas não terminada');
        addProp(name);
        i = j + 2;
      } else {
        const end = path.indexOf(']', i);
        if (end < 0) fail('colchete não fechado');
        const inner = path.slice(i + 1, end);
        if (inner === '*') segments.push({ kind: 'wildcard' });
        else if (/^\d+$/.test(inner)) segments.push({ kind: 'index', index: Number(inner) });
        else fail(`conteúdo de colchetes inválido "${inner}"`);
        i = end + 1;
      }
    } else {
      if (!expectKey && segments.length > 0) fail('esperado "." ou "["');
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      const name = path.slice(i, j);
      if (name === '') fail('nome de propriedade vazio');
      addProp(name);
      expectKey = false;
      i = j;
    }
  }
  if (expectKey) fail('o caminho não pode terminar em ponto');
  return segments;
}

/** Gera o caminho canônico. `formatPath(parsePath(x))` preserva a semântica de `x`. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'wildcard') out += '[*]';
    else if (seg.kind === 'index') out += `[${seg.index}]`;
    else if (SIMPLE_KEY.test(seg.name)) out += out === '' ? seg.name : `.${seg.name}`;
    else out += `["${seg.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  }
  return out;
}

export function parsePathOrEmpty(path: string): PathSegment[] {
  return path === '' ? [] : parsePath(path);
}

export function childPath(parent: string, key: string): string {
  return formatPath([...parsePathOrEmpty(parent), { kind: 'prop', name: key }]);
}

export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return path.length > 0;
  } catch {
    return false;
  }
}

export function countWildcards(segments: readonly PathSegment[]): number {
  return segments.reduce((n, s) => n + (s.kind === 'wildcard' ? 1 : 0), 0);
}

/** `orders[*].items[*].id` => [`orders[*]`, `orders[*].items[*]`]. */
export function wildcardPrefixes(path: string): string[] {
  const segs = parsePathOrEmpty(path);
  const prefixes: string[] = [];
  segs.forEach((s, i) => {
    if (s.kind === 'wildcard') prefixes.push(formatPath(segs.slice(0, i + 1)));
  });
  return prefixes;
}

export function isObject(v: unknown): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function ownProp(obj: JsonValue | undefined, key: string): JsonValue | undefined {
  return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Lê um caminho sem modificar nada. `[*]` coleta os valores em um array plano; itens em que
 * o resto do caminho não existe viram `null`, preservando a posição.
 */
export function getIn(root: JsonValue | undefined, path: string): JsonValue | undefined {
  return getBound(root, parsePathOrEmpty(path), []);
}

/**
 * Como `getIn`, mas os primeiros `[*]` usam as posições de `indices`: é o que preserva o
 * contexto do item corrente durante a iteração.
 */
export function getBound(
  root: JsonValue | undefined,
  segments: readonly PathSegment[],
  indices: readonly number[],
): JsonValue | undefined {
  return walk(root, segments, 0, indices, 0);
}

function walk(
  current: JsonValue | undefined,
  segs: readonly PathSegment[],
  pos: number,
  indices: readonly number[],
  wildcardPos: number,
): JsonValue | undefined {
  if (pos === segs.length) return current;
  if (current === undefined || current === null) return undefined;
  const seg = segs[pos];
  if (seg.kind === 'prop') {
    return walk(ownProp(current, seg.name), segs, pos + 1, indices, wildcardPos);
  }
  if (!Array.isArray(current)) return undefined;
  if (seg.kind === 'index') return walk(current[seg.index], segs, pos + 1, indices, wildcardPos);
  if (wildcardPos < indices.length) {
    return walk(current[indices[wildcardPos]], segs, pos + 1, indices, wildcardPos + 1);
  }
  const collected: JsonValue[] = [];
  const hasMoreWildcards = segs.slice(pos + 1).some((s) => s.kind === 'wildcard');
  for (const item of current) {
    const v = walk(item, segs, pos + 1, indices, wildcardPos + 1);
    if (hasMoreWildcards) {
      if (Array.isArray(v)) collected.push(...v);
    } else {
      collected.push(v === undefined ? null : v);
    }
  }
  return collected;
}

/** Escrita imutável: devolve uma nova raiz e compartilha os ramos não alterados. */
export function setIn(root: JsonValue | undefined, path: string, value: JsonValue): JsonValue {
  return setSegments(root, parsePath(path), 0, value);
}

function setSegments(
  current: JsonValue | undefined,
  segs: readonly PathSegment[],
  pos: number,
  value: JsonValue,
): JsonValue {
  if (pos === segs.length) return value;
  const seg = segs[pos];
  if (seg.kind === 'prop') {
    const base = isObject(current) ? current : {};
    return { ...base, [seg.name]: setSegments(ownProp(base, seg.name), segs, pos + 1, value) };
  }
  if (seg.kind === 'index') {
    const base: JsonValue[] = Array.isArray(current) ? [...current] : [];
    while (base.length < seg.index) base.push(null);
    base[seg.index] = setSegments(base[seg.index], segs, pos + 1, value);
    return base;
  }
  throw new PathSyntaxError('setIn não aceita [*]; use caminhos com índice.', formatPath(segs));
}

/** Cópia profunda: o resultado nunca compartilha referências com a entrada. */
export function cloneJson<T extends JsonValue | undefined>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v)) as T;
  const copy: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__') continue;
    copy[key] = cloneJson((value as { [key: string]: JsonValue })[key]);
  }
  return copy as T;
}
