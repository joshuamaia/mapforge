import { JsonValue } from '../models/json.model';
import { ArrayScope, Condition, Mapping } from '../models/mapping.model';
import { EngineIssue, ExecutionResult, IgnoredField, StepTrace } from '../models/execution.model';
import { sortItems, validateStep } from '../transformations/catalog';
import { evaluate, evaluateOnItem, isNil, Value } from '../transformations/values';
import {
  cloneJson,
  countWildcards,
  formatPath,
  getBound,
  getIn,
  isObject,
  parsePath,
  parsePathOrEmpty,
  PathSegment,
} from './path';
import { runPipeline } from './pipeline';

export interface EngineInput {
  source: JsonValue;
  mappings: readonly Mapping[];
  scopes?: readonly ArrayScope[];
}

/** Linha de iteração: posições na origem e, em paralelo, no destino. */
interface Row {
  sourceIndices: number[];
  targetIndices: number[];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Executa os mapeamentos sobre `source`, sem alterá-lo. A ordem é determinística: primeiro os
 * mapeamentos que definem as linhas dos arrays e depois os que apenas copiam valores do
 * contexto pai para linhas já existentes.
 */
export function executeMappings(input: EngineInput): ExecutionResult {
  return new Execution(input).run();
}

class Execution {
  private readonly holder: { root?: JsonValue } = {};
  private readonly issues: EngineIssue[] = [];
  private readonly ignored: IgnoredField[] = [];
  private readonly traces: Record<string, StepTrace[]> = {};
  private readonly written = new Set<string>();
  private transformationRuns = 0;
  private conversionErrors = 0;
  private readonly source: JsonValue;
  private readonly mappings: readonly Mapping[];
  private readonly scopes: readonly ArrayScope[];

  constructor(input: EngineInput) {
    this.source = input.source;
    this.mappings = input.mappings;
    this.scopes = input.scopes ?? [];
  }

  run(): ExecutionResult {
    const start = now();
    const valid = this.mappings.filter((m) => this.validate(m));
    const rank = (m: Mapping): number => (this.isBroadcast(m) ? 1 : 0);
    const ordered = valid
      .map((m, i) => ({ m, i }))
      .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);
    for (const { m } of ordered) {
      try {
        this.runMapping(m);
      } catch (e) {
        this.issue('error', 'runtime', m, e instanceof Error ? e.message : String(e));
      }
    }
    const transformations = valid.reduce(
      (n, m) => n + m.transforms.filter((t) => !t.disabled).length,
      0,
    );
    return {
      ok: !this.issues.some((i) => i.severity === 'error'),
      output: this.holder.root ?? {},
      issues: this.issues,
      ignored: this.ignored,
      traces: this.traces,
      stats: {
        mappedFields: this.written.size,
        transformations,
        transformationRuns: this.transformationRuns,
        conversionErrors: this.conversionErrors,
        durationMs: Math.round((now() - start) * 100) / 100,
      },
    };
  }

  private issue(
    severity: EngineIssue['severity'],
    kind: EngineIssue['kind'],
    m: Mapping,
    message: string,
  ): void {
    this.issues.push({ severity, kind, mappingId: m.id, field: m.targetPath, message });
  }

  /** Validação anterior à execução: um mapeamento inválido é ignorado, nunca executado pela metade. */
  private validate(m: Mapping): boolean {
    const skip = (message: string): boolean => {
      this.issue('error', 'validation', m, message);
      this.ignored.push({ path: m.targetPath, mappingId: m.id, reason: message });
      return false;
    };
    let target: PathSegment[];
    try {
      parsePathOrEmpty(m.sourcePath);
      target = parsePathOrEmpty(m.targetPath);
      for (const c of m.conditions ?? []) parsePathOrEmpty(c.field);
    } catch (e) {
      return skip((e as Error).message);
    }
    if (target.length === 0) return skip('O mapeamento não tem campo de destino.');
    if (target.some((s) => s.kind === 'index')) {
      return skip(`Índice fixo não é aceito no destino "${m.targetPath}". Use [*].`);
    }
    const stepErrors = m.transforms.filter((t) => !t.disabled).flatMap(validateStep);
    if (stepErrors.length) return skip(stepErrors.join(' '));
    return true;
  }

  private isBroadcast(m: Mapping): boolean {
    const s = countWildcards(parsePathOrEmpty(m.sourcePath));
    const t = countWildcards(parsePathOrEmpty(m.targetPath));
    return t > s;
  }

  private runMapping(m: Mapping): void {
    const src = parsePathOrEmpty(m.sourcePath);
    const tgt = parsePath(m.targetPath);
    const aligned = Math.min(countWildcards(src), countWildcards(tgt));
    const rows = this.expandAligned(m, src, tgt, aligned);
    let wroteAny = false;
    let firstRow = true;

    for (const row of rows) {
      const outcome = this.computeValue(m, src, row, firstRow);
      firstRow = false;
      if (outcome.skipped) continue;
      let value = outcome.value;
      if (isNil(value) && m.defaultValue !== undefined) value = m.defaultValue;
      if (value === undefined) continue;
      if (this.write(m, tgt, row.targetIndices, cloneJson(value))) wroteAny = true;
    }
    if (wroteAny) this.written.add(m.targetPath);
    else if (rows.length > 0 || countWildcards(src) === 0) {
      this.ignored.push({
        path: m.targetPath,
        mappingId: m.id,
        reason: m.sourcePath
          ? `Sem valor em "${m.sourcePath}" ou condição não atendida.`
          : 'Sem valor produzido.',
      });
    } else if (!this.written.has(m.targetPath)) {
      // Array vazio já foi materializado no destino; array ausente não produz nada.
      const arrayPresent = this.emptyArrayMaterialized(src);
      if (arrayPresent) this.written.add(m.targetPath);
      else {
        this.ignored.push({
          path: m.targetPath,
          mappingId: m.id,
          reason: `Array de origem ausente em "${m.sourcePath}".`,
        });
        this.issue(
          'warning',
          'missing',
          m,
          `O array de origem de "${m.sourcePath}" não existe nos dados.`,
        );
      }
    }
  }

  private emptyArrayMaterialized(src: readonly PathSegment[]): boolean {
    const firstWildcard = src.findIndex((s) => s.kind === 'wildcard');
    return Array.isArray(getBound(this.source, src.slice(0, firstWildcard), []));
  }

  /** Expande os `[*]` alinhados origem/destino, respeitando o escopo de cada par de arrays. */
  private expandAligned(
    m: Mapping,
    src: readonly PathSegment[],
    tgt: readonly PathSegment[],
    aligned: number,
  ): Row[] {
    if (aligned === 0) return [{ sourceIndices: [], targetIndices: [] }];
    const srcWildcards = src.flatMap((s, i) => (s.kind === 'wildcard' ? [i] : []));
    const tgtWildcards = tgt.flatMap((s, i) => (s.kind === 'wildcard' ? [i] : []));
    let rows: Row[] = [{ sourceIndices: [], targetIndices: [] }];

    for (let level = 0; level < aligned; level++) {
      const srcArrayPath = src.slice(0, srcWildcards[level]);
      const tgtArrayPath = tgt.slice(0, tgtWildcards[level]);
      const scope = this.findScope(
        formatPath(src.slice(0, srcWildcards[level] + 1)),
        formatPath(tgt.slice(0, tgtWildcards[level] + 1)),
      );
      const next: Row[] = [];
      for (const row of rows) {
        const array = getBound(this.source, srcArrayPath, row.sourceIndices);
        if (array === undefined || array === null) continue;
        if (!Array.isArray(array)) {
          this.issue(
            'warning',
            'conflict',
            m,
            `"${formatPath(srcArrayPath)}" não é um array nos dados.`,
          );
          continue;
        }
        const selected = applyScope(array, scope);
        if (selected.length === 0) this.ensureEmptyArray(m, tgtArrayPath, row.targetIndices);
        selected.forEach((sourceIndex, position) => {
          next.push({
            sourceIndices: [...row.sourceIndices, sourceIndex],
            targetIndices: [...row.targetIndices, position],
          });
        });
      }
      rows = next;
      // Cria as linhas no destino, mesmo que todos os campos sejam omitidos depois.
      for (const row of rows) {
        const nextSeg = tgt[tgtWildcards[level] + 1];
        if (nextSeg && nextSeg.kind === 'prop') {
          this.ensureRow(m, tgt.slice(0, tgtWildcards[level] + 1), row.targetIndices);
        }
      }
    }
    return rows;
  }

  private findScope(sourcePath: string, targetPath: string): ArrayScope | undefined {
    return this.scopes.find((s) => s.sourcePath === sourcePath && s.targetPath === targetPath);
  }

  private computeValue(
    m: Mapping,
    src: readonly PathSegment[],
    row: Row,
    collectTrace: boolean,
  ): { value: Value; skipped: boolean } {
    const conditions = m.conditions ?? [];
    const total = countWildcards(src);
    const excess = total - row.sourceIndices.length;
    let input: Value;
    if (m.sourcePath === '') {
      input = undefined;
    } else if (excess > 0) {
      // Coleta dentro da linha corrente; as condições valem por elemento coletado.
      input = this.collect(src, row.sourceIndices, conditions);
    } else {
      if (!this.conditionsHold(conditions, row.sourceIndices)) {
        this.ignored.push({
          path: m.targetPath,
          mappingId: m.id,
          reason: 'Condição do mapeamento não atendida.',
        });
        return { value: undefined, skipped: true };
      }
      input = getBound(this.source, src, row.sourceIndices);
      if (input === undefined) {
        const field = formatPath(src);
        if (!this.issues.some((i) => i.mappingId === m.id && i.kind === 'missing')) {
          this.issue(
            'info',
            'missing',
            m,
            `Propriedade "${field}" não existe nos dados de entrada.`,
          );
        }
      }
    }
    const ctx = {
      resolve: (path: string): Value =>
        getBound(this.source, parsePathOrEmpty(path), row.sourceIndices),
    };
    const outcome = runPipeline(input, m.transforms, ctx, collectTrace);
    this.transformationRuns += outcome.runs;
    if (collectTrace) this.traces[m.id] = outcome.trace;
    for (const message of outcome.errors) {
      this.conversionErrors++;
      this.issue('error', 'conversion', m, message);
    }
    return { value: outcome.value, skipped: false };
  }

  private conditionsHold(conditions: readonly Condition[], indices: readonly number[]): boolean {
    return conditions.every((c) =>
      evaluate(getBound(this.source, parsePathOrEmpty(c.field), indices), c.operator, c.value),
    );
  }

  private collect(
    src: readonly PathSegment[],
    bound: readonly number[],
    conditions: readonly Condition[],
  ): Value {
    const lastBound = indexOfWildcard(src, bound.length);
    const array = getBound(this.source, src.slice(0, lastBound), bound);
    if (isNil(array)) return undefined;
    if (!Array.isArray(array)) return undefined;
    const out: JsonValue[] = [];
    const descend = (indices: number[]): void => {
      const remaining = countWildcards(src) - indices.length;
      if (remaining === 0) {
        if (this.conditionsHold(conditions, indices)) {
          const v = getBound(this.source, src, indices);
          out.push(v === undefined ? null : v);
        }
        return;
      }
      const at = indexOfWildcard(src, indices.length);
      const inner = getBound(this.source, src.slice(0, at), indices);
      if (!Array.isArray(inner)) return;
      inner.forEach((_, i) => descend([...indices, i]));
    };
    descend([...bound]);
    return out;
  }

  // ------------------------------------------------------------------ escrita no destino

  private ensureEmptyArray(
    m: Mapping,
    arrayPath: readonly PathSegment[],
    indices: readonly number[],
  ): void {
    const parent = this.navigate(m, arrayPath, indices);
    if (parent && parent.value === undefined) parent.set([]);
  }

  private ensureRow(m: Mapping, rowPath: readonly PathSegment[], indices: readonly number[]): void {
    const slot = this.navigate(m, rowPath, indices);
    if (slot && slot.value === undefined) slot.set({});
  }

  /**
   * Caminha pelo resultado criando contêineres intermediários. O resultado é um objeto novo,
   * construído apenas pelo motor: a entrada nunca é alterada, pois os valores são clonados.
   */
  private navigate(
    m: Mapping,
    segs: readonly PathSegment[],
    indices: readonly number[],
  ): { value: JsonValue | undefined; set: (v: JsonValue) => void } | null {
    let getter = (): JsonValue | undefined => this.holder.root;
    let setter = (v: JsonValue): void => {
      this.holder.root = v;
    };
    let w = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const needArray = seg.kind === 'wildcard';
      let container = getter();
      if (container === undefined || container === null) {
        container = needArray ? [] : {};
        setter(container);
      } else if (needArray ? !Array.isArray(container) : !isObject(container)) {
        this.issue(
          'error',
          'conflict',
          m,
          `Conflito de caminhos em "${formatPath(segs.slice(0, i))}": o valor já escrito não é ${needArray ? 'um array' : 'um objeto'}.`,
        );
        return null;
      }
      if (seg.kind === 'prop') {
        const obj = container as { [k: string]: JsonValue };
        const key = seg.name;
        getter = () => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
        setter = (v) => {
          obj[key] = v;
        };
      } else {
        const arr = container as JsonValue[];
        const at = indices[w++];
        getter = () => arr[at];
        setter = (v) => {
          while (arr.length < at) arr.push(null);
          arr[at] = v;
        };
      }
    }
    return { value: getter(), set: setter };
  }

  /** Escreve o valor. Se o destino tem mais `[*]` que a origem, copia para as linhas existentes. */
  private write(
    m: Mapping,
    tgt: readonly PathSegment[],
    indices: readonly number[],
    value: JsonValue,
  ): boolean {
    const total = countWildcards(tgt);
    if (indices.length === total) {
      const slot = this.navigate(m, tgt, indices);
      if (!slot) return false;
      slot.set(value);
      return true;
    }
    const nextWildcard = indexOfWildcard(tgt, indices.length);
    const arrayPath = tgt.slice(0, nextWildcard);
    const array = readTarget(this.holder.root, arrayPath, indices);
    if (!Array.isArray(array)) {
      this.issue(
        'warning',
        'missing',
        m,
        `Nenhuma linha em "${formatPath(arrayPath)}" para receber o valor. Mapeie antes um campo de um array de origem para esse array.`,
      );
      return false;
    }
    let wrote = false;
    array.forEach((_, i) => {
      if (this.write(m, tgt, [...indices, i], cloneJson(value))) wrote = true;
    });
    return wrote;
  }
}

function indexOfWildcard(segs: readonly PathSegment[], ordinal: number): number {
  let seen = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].kind === 'wildcard') {
      if (seen === ordinal) return i;
      seen++;
    }
  }
  return -1;
}

function readTarget(
  root: JsonValue | undefined,
  segs: readonly PathSegment[],
  indices: readonly number[],
): JsonValue | undefined {
  return getBound(root, segs, indices);
}

/**
 * Posições selecionadas de um array de origem, já filtradas, sem repetições e ordenadas.
 * Devolve índices (e não itens) para que todos os campos da linha leiam do mesmo elemento.
 */
export function applyScope(array: readonly JsonValue[], scope?: ArrayScope): number[] {
  let positions = array.map((_, i) => i);
  if (!scope) return positions;
  const filters = scope.filter ?? [];
  if (filters.length) {
    positions = positions.filter((i) => filters.every((c) => evaluateOnItem(array[i], c)));
  }
  if (scope.distinctBy) {
    const seen = new Set<string>();
    positions = positions.filter((i) => {
      const key = JSON.stringify(getIn(array[i], scope.distinctBy as string) ?? null);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (scope.sort) {
    const { field, direction } = scope.sort;
    const wrapped = positions.map((i) => ({ i, v: getIn(array[i], field) ?? null }));
    const sorted = sortItems(
      wrapped as unknown as JsonValue[],
      'v',
      direction,
    ) as unknown as typeof wrapped;
    positions = sorted.map((x) => x.i);
  }
  return positions;
}
