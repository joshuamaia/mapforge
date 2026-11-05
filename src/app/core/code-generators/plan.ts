import { ArrayScope, Mapping } from '../models/mapping.model';
import { ProjectDocument } from '../models/project.model';
import { FieldNode, ParseResult } from '../models/schema.model';
import {
  countWildcards,
  formatPath,
  parsePathOrEmpty,
  PathSegment,
  wildcardPrefixes,
} from '../mapping-engine/path';
import { flattenFields, parseStructure } from '../parsers/structure';
import { getTransform, validateStep } from '../transformations/catalog';

export interface PlanLeaf {
  kind: 'leaf';
  mapping: Mapping;
  sourceSegs: PathSegment[];
  node?: FieldNode;
}

export interface PlanObject {
  kind: 'object';
  node?: FieldNode;
  /** Ordem de declaração preservada. */
  children: Map<string, PlanNode>;
}

export interface PlanArray {
  kind: 'array';
  node?: FieldNode;
  sourcePrefix?: string;
  scope?: ArrayScope;
  item?: PlanNode;
}

export type PlanNode = PlanLeaf | PlanObject | PlanArray;

export interface MappingPlan {
  root: PlanObject | PlanArray;
  source: ParseResult;
  target: ParseResult;
  warnings: string[];
  included: Mapping[];
}

/**
 * Traduz a lista plana de mapeamentos na árvore do destino, que todos os geradores percorrem.
 * Um mapeamento que o motor rejeitaria, ou que um gerador não consegue representar, é excluído e
 * gera aviso: o código gerado nunca finge cobrir o que não cobre.
 */
export function buildPlan(doc: ProjectDocument): MappingPlan {
  const source = parseStructure(doc.source);
  const target = parseStructure(doc.target);
  const warnings: string[] = [];
  const sourceFields = new Map(flattenFields(source.root).map((n) => [n.path, n]));
  const targetFields = new Map(flattenFields(target.root).map((n) => [n.path, n]));
  const included: Mapping[] = [];

  const rootIsArray =
    doc.mappings.length > 0
      ? doc.mappings.some((m) => safeSegs(m.targetPath)?.[0]?.kind === 'wildcard')
      : target.root?.type === 'array';
  const root: PlanObject | PlanArray = rootIsArray
    ? { kind: 'array', node: target.root ?? undefined }
    : { kind: 'object', node: target.root ?? undefined, children: new Map() };

  const skip = (m: Mapping, why: string): void => {
    warnings.push(
      `Mapeamento ${m.sourcePath || '(constante)'} → ${m.targetPath} não foi gerado: ${why}`,
    );
  };

  // Mapeamentos que definem as linhas de um array vêm antes dos que apenas copiam para elas.
  const isBroadcast = (m: Mapping): boolean =>
    countWildcards(safeSegs(m.targetPath) ?? []) > countWildcards(safeSegs(m.sourcePath) ?? []);
  const ordered = [
    ...doc.mappings.filter((m) => !isBroadcast(m)),
    ...doc.mappings.filter(isBroadcast),
  ];

  for (const m of ordered) {
    const src = safeSegs(m.sourcePath);
    const tgt = safeSegs(m.targetPath);
    if (!src || !tgt || tgt.length === 0) {
      skip(m, 'caminho inválido.');
      continue;
    }
    if (tgt.some((s) => s.kind === 'index')) {
      skip(m, 'índice fixo no destino.');
      continue;
    }
    if (
      m.sourcePath !== '' &&
      source.root &&
      !sourceFields.has(m.sourcePath) &&
      !hasIndexMatch(src, sourceFields)
    ) {
      skip(m, 'campo de origem inexistente.');
      continue;
    }
    if (target.root && !targetFields.has(m.targetPath)) {
      skip(m, 'campo de destino inexistente.');
      continue;
    }
    const errors = m.transforms.filter((t) => !t.disabled).flatMap(validateStep);
    if (errors.length) {
      skip(m, errors.join(' '));
      continue;
    }
    const unknown = m.transforms.find((t) => !getTransform(t.transformId));
    if (unknown) {
      skip(m, `transformação desconhecida (${unknown.transformId}).`);
      continue;
    }
    const failure = insert(root, m, src, tgt, doc.scopes, targetFields);
    if (failure) skip(m, failure);
    else included.push(m);
  }
  return { root, source, target, warnings, included };
}

function safeSegs(path: string): PathSegment[] | null {
  try {
    return parsePathOrEmpty(path);
  } catch {
    return null;
  }
}

function hasIndexMatch(segs: PathSegment[], fields: Map<string, FieldNode>): boolean {
  if (!segs.some((s) => s.kind === 'index')) return false;
  return fields.has(
    formatPath(segs.map((s): PathSegment => (s.kind === 'index' ? { kind: 'wildcard' } : s))),
  );
}

function insert(
  root: PlanObject | PlanArray,
  m: Mapping,
  src: PathSegment[],
  tgt: PathSegment[],
  scopes: readonly ArrayScope[],
  targetFields: Map<string, FieldNode>,
): string | null {
  const srcPrefixes = wildcardPrefixes(m.sourcePath);
  let current: PlanNode = root;
  let level = 0;
  const startIsWildcard = tgt[0].kind === 'wildcard';
  if (root.kind === 'array' && !startIsWildcard)
    return 'o destino mistura raiz array e raiz objeto.';
  if (root.kind === 'object' && startIsWildcard)
    return 'o destino mistura raiz array e raiz objeto.';

  for (let i = 0; i < tgt.length; i++) {
    const seg = tgt[i];
    const isLast = i === tgt.length - 1;
    const pathSoFar = formatPath(tgt.slice(0, i + 1));
    if (seg.kind === 'prop') {
      if (current.kind !== 'object') return `conflito de caminhos em "${pathSoFar}".`;
      const existing: PlanNode | undefined = current.children.get(seg.name);
      if (isLast) {
        if (existing && existing.kind !== 'leaf') return `conflito de caminhos em "${pathSoFar}".`;
        current.children.set(seg.name, leaf(m, src, targetFields.get(m.targetPath)));
        return null;
      }
      const nextIsWildcard = tgt[i + 1].kind === 'wildcard';
      if (existing) {
        if (
          existing.kind === 'leaf' ||
          (nextIsWildcard ? existing.kind !== 'array' : existing.kind !== 'object')
        ) {
          return `conflito de caminhos em "${pathSoFar}".`;
        }
        current = existing;
      } else {
        const created: PlanNode = nextIsWildcard
          ? { kind: 'array', node: targetFields.get(pathSoFar) }
          : { kind: 'object', node: targetFields.get(pathSoFar), children: new Map() };
        current.children.set(seg.name, created);
        current = created;
      }
    } else {
      if (current.kind !== 'array') return `conflito de caminhos em "${pathSoFar}".`;
      const prefix = srcPrefixes[level];
      if (prefix !== undefined) {
        if (current.sourcePrefix && current.sourcePrefix !== prefix) {
          return `"${pathSoFar}" já é alimentado por "${current.sourcePrefix}".`;
        }
        current.sourcePrefix = prefix;
        current.scope = scopes.find((s) => s.sourcePath === prefix && s.targetPath === pathSoFar);
      } else if (!current.sourcePrefix) {
        return `nenhum outro mapeamento cria as linhas de "${pathSoFar}".`;
      }
      level++;
      if (isLast) {
        if (current.item && current.item.kind !== 'leaf')
          return `conflito de caminhos em "${pathSoFar}".`;
        current.item = leaf(m, src, targetFields.get(m.targetPath));
        return null;
      }
      const nextIsWildcard = tgt[i + 1].kind === 'wildcard';
      if (current.item) {
        if (
          current.item.kind === 'leaf' ||
          (nextIsWildcard ? current.item.kind !== 'array' : current.item.kind !== 'object')
        ) {
          return `conflito de caminhos em "${pathSoFar}".`;
        }
      } else {
        current.item = nextIsWildcard
          ? { kind: 'array', node: targetFields.get(pathSoFar) }
          : { kind: 'object', node: targetFields.get(pathSoFar), children: new Map() };
      }
      current = current.item;
    }
  }
  return null;
}

function leaf(m: Mapping, sourceSegs: PathSegment[], node: FieldNode | undefined): PlanLeaf {
  return { kind: 'leaf', mapping: m, sourceSegs, node };
}

/** Atribui nomes de tipo únicos aos objetos das duas estruturas. */
export class TypeNamer {
  private readonly names = new Map<FieldNode, string>();
  private readonly used = new Map<string, FieldNode>();

  constructor(
    readonly sourceRoot: FieldNode | null,
    readonly targetRoot: FieldNode | null,
    sourceRootName: string,
    targetRootName: string,
  ) {
    if (sourceRoot) this.assign(sourceRoot, pascalCase(sourceRootName) || 'Source', 'Source');
    if (targetRoot) this.assign(targetRoot, pascalCase(targetRootName) || 'Target', 'Target');
  }

  private assign(node: FieldNode, fallback: string, side: string): void {
    const declared = node.typeName ?? (node.path === '' ? node.nativeType : undefined);
    if (node.type === 'object' || (node.type === 'array' && hasObjectItems(node))) {
      let base = declared ?? fallback;
      if (node.type === 'array' && !declared) base = `${fallback}Item`;
      this.names.set(node, this.unique(base, node, side));
    }
    for (const child of node.children ?? []) {
      if (child.name === '[*]') this.assign(child, fallback, side);
      else this.assign(child, pascalCase(child.name) || 'Value', side);
    }
  }

  private unique(base: string, node: FieldNode, side: string): string {
    const clean = base;
    const existing = this.used.get(clean);
    if (!existing || sameShape(existing, node)) {
      this.used.set(clean, existing ?? node);
      return clean;
    }
    let candidate = `${clean}${side}`;
    let i = 2;
    while (this.used.has(candidate) && !sameShape(this.used.get(candidate) as FieldNode, node)) {
      candidate = `${clean}${side}${i++}`;
    }
    this.used.set(candidate, this.used.get(candidate) ?? node);
    return candidate;
  }

  nameOf(node: FieldNode): string {
    return this.names.get(node) ?? 'Object';
  }

  /** Objetos a declarar, sem repetir nomes. */
  declarations(root: FieldNode | null): FieldNode[] {
    if (!root) return [];
    const seen = new Set<string>();
    const out: FieldNode[] = [];
    const visit = (n: FieldNode): void => {
      const name = this.names.get(n);
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(n);
      }
      n.children?.forEach(visit);
    };
    visit(root);
    return out;
  }
}

export function hasObjectItems(node: FieldNode): boolean {
  return (node.children?.length ?? 0) > 0 && node.children?.[0].name !== '[*]';
}

function shapeOf(n: FieldNode): string {
  return (n.children ?? []).map((c) => `${c.name}:${c.type}:${shapeOf(c)}`).join(',');
}

function sameShape(a: FieldNode, b: FieldNode): boolean {
  return shapeOf(a) === shapeOf(b);
}

export function splitIdentifier(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '');
}

export function pascalCase(name: string): string {
  const out = splitIdentifier(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^\d/.test(out) ? `T${out}` : out;
}

export function camelCase(name: string): string {
  const p = pascalCase(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

export function kebabCase(name: string): string {
  return splitIdentifier(name)
    .map((w) => w.toLowerCase())
    .join('-');
}
