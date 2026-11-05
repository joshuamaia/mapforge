import { JsonValue } from '../models/json.model';
import { ArrayScope, Mapping, ValidationStatus } from '../models/mapping.model';
import { Diagnostic, DiagnosticCode, DiagnosticSeverity } from '../models/diagnostic.model';
import { ProjectDocument } from '../models/project.model';
import { FieldNode, FieldType, ParseResult } from '../models/schema.model';
import {
  countWildcards,
  formatPath,
  getIn,
  parsePath,
  parsePathOrEmpty,
  PathSegment,
  wildcardPrefixes,
} from '../mapping-engine/path';
import { flowStep, getTransform, TypeFlow, validateStep } from '../transformations/catalog';
import { flattenFields, indexFields, parseStructure } from '../parsers/structure';
import { DEFAULT_LIMITS, ParseLimits, parseJsonSafe } from '../parsers/json-parser';
import { isNil } from '../transformations/values';
import { typeCompatibility } from './type-compat';

export interface DiagnosticsInput {
  mappings: readonly Mapping[];
  scopes?: readonly ArrayScope[];
  source: ParseResult;
  target: ParseResult;
  /** Dados de entrada, para detectar valores nulos inesperados. */
  sampleData?: JsonValue;
  sampleError?: string;
}

class Collector {
  readonly list: Diagnostic[] = [];
  add(
    code: DiagnosticCode,
    severity: DiagnosticSeverity,
    field: string,
    message: string,
    suggestion: string,
    mappingId?: string,
  ): void {
    this.list.push({
      id: `${code}:${field}:${mappingId ?? ''}:${this.list.length}`,
      code,
      severity,
      field,
      message,
      suggestion,
      mappingId,
    });
  }
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Regras estáticas do mapeamento. Não executa os mapeamentos. */
export function runDiagnostics(input: DiagnosticsInput): Diagnostic[] {
  const out = new Collector();
  const sourceFields = indexFields(input.source.root);
  const targetFields = indexFields(input.target.root);

  structureNotices(out, 'Source', input.source);
  structureNotices(out, 'Target', input.target);
  if (input.sampleError) {
    out.add(
      'structure-invalid',
      'error',
      'Dados de entrada',
      input.sampleError,
      'Corrija o JSON de entrada no painel Source.',
    );
  }

  for (const m of input.mappings) {
    checkMapping(out, m, input, sourceFields, targetFields);
  }
  checkDuplicates(out, input.mappings);
  checkPathConflicts(out, input.mappings);
  checkArraySources(out, input.mappings);
  checkCircular(out, input.mappings);
  checkScopes(out, input.scopes ?? [], input.mappings, sourceFields);
  checkRequired(out, input.mappings, input.target.root);

  return out.list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function structureNotices(out: Collector, label: string, result: ParseResult): void {
  for (const issue of result.issues) {
    const field = issue.path ? issue.path : label;
    const where = issue.line
      ? ` (linha ${issue.line}${issue.column ? `, coluna ${issue.column}` : ''})`
      : '';
    if (issue.kind === 'circular') {
      out.add(
        'circular-reference',
        'warning',
        field,
        issue.message,
        'Mapeie os campos do nível repetido por outro caminho ou quebre a referência no DTO.',
      );
    } else if (issue.severity === 'error') {
      out.add(
        'structure-invalid',
        'error',
        label,
        `${issue.message}${where}`,
        `Corrija a estrutura de ${label}.`,
      );
    } else {
      out.add(
        'parser-notice',
        issue.severity,
        field,
        `${issue.message}${where}`,
        issue.kind === 'unresolved'
          ? 'Inclua a declaração que falta no texto da estrutura.'
          : 'Ajuste a declaração ou aceite o campo com tipo genérico.',
      );
    }
  }
}

function safeSegments(path: string): PathSegment[] | null {
  try {
    return parsePathOrEmpty(path);
  } catch {
    return null;
  }
}

/** Tipo da origem como chega à primeira etapa: `[*]` não alinhados produzem uma lista. */
export function initialFlow(
  sourcePath: string,
  targetPath: string,
  sourceFields: Map<string, FieldNode>,
): TypeFlow {
  const node = sourceFields.get(sourcePath);
  if (!node) return { type: 'any' };
  const src = countWildcards(parsePathOrEmpty(sourcePath));
  const tgt = countWildcards(parsePathOrEmpty(targetPath));
  if (src > tgt) return { type: 'array', itemType: node.type };
  return { type: node.type, itemType: node.itemType };
}

export function pipelineOutputType(m: Mapping, sourceFields: Map<string, FieldNode>): TypeFlow {
  return m.transforms.reduce(flowStep, initialFlow(m.sourcePath, m.targetPath, sourceFields));
}

function checkMapping(
  out: Collector,
  m: Mapping,
  input: DiagnosticsInput,
  sourceFields: Map<string, FieldNode>,
  targetFields: Map<string, FieldNode>,
): void {
  const srcSegs = safeSegments(m.sourcePath);
  const tgtSegs = safeSegments(m.targetPath);
  const label = m.targetPath || m.sourcePath;
  if (!srcSegs) {
    out.add(
      'source-missing',
      'error',
      m.sourcePath,
      `Caminho de origem inválido: "${m.sourcePath}".`,
      'Corrija a sintaxe do caminho, como pedidos[*].codigo.',
      m.id,
    );
  }
  if (!tgtSegs) {
    out.add(
      'target-missing',
      'error',
      m.targetPath,
      `Caminho de destino inválido: "${m.targetPath}".`,
      'Corrija a sintaxe do caminho, como orders[*].id.',
      m.id,
    );
  }
  if (!srcSegs || !tgtSegs) return;
  if (tgtSegs.some((s) => s.kind === 'index')) {
    out.add(
      'target-missing',
      'error',
      m.targetPath,
      'Índice fixo não é aceito no destino.',
      'Use [*] no caminho de destino.',
      m.id,
    );
    return;
  }

  const sourceNode = sourceFields.get(m.sourcePath);
  const targetNode = targetFields.get(m.targetPath);
  if (
    m.sourcePath !== '' &&
    !sourceNode &&
    input.source.root &&
    !hasFixedIndex(srcSegs, sourceFields)
  ) {
    out.add(
      'source-missing',
      'error',
      m.sourcePath,
      `O campo de origem "${m.sourcePath}" não existe na estrutura.`,
      'Remova o mapeamento ou atualize a estrutura de origem.',
      m.id,
    );
  }
  if (!targetNode && input.target.root) {
    out.add(
      'target-missing',
      'error',
      m.targetPath,
      `O campo de destino "${m.targetPath}" não existe na estrutura.`,
      'Remova o mapeamento ou atualize a estrutura de destino.',
      m.id,
    );
  }
  if (
    m.sourcePath === '' &&
    !m.transforms.some((t) => !t.disabled && getTransform(t.transformId)?.handlesNull) &&
    m.defaultValue === undefined
  ) {
    out.add(
      'source-missing',
      'warning',
      label,
      'O mapeamento não tem origem nem produz um valor próprio.',
      'Adicione uma transformação Constant Value ou um valor padrão.',
      m.id,
    );
  }

  checkTransforms(out, m, sourceFields);
  checkArrays(out, m, srcSegs, tgtSegs, sourceNode, targetNode);
  checkTypes(out, m, sourceNode, targetNode, sourceFields);
  checkConditions(out, m, srcSegs);
  checkNullData(out, m, input.sampleData, sourceNode, targetNode, srcSegs);
}

function hasFixedIndex(segs: PathSegment[], fields: Map<string, FieldNode>): boolean {
  if (!segs.some((s) => s.kind === 'index')) return false;
  const wild = segs.map((s): PathSegment => (s.kind === 'index' ? { kind: 'wildcard' } : s));
  return fields.has(formatPath(wild));
}

function checkTransforms(out: Collector, m: Mapping, sourceFields: Map<string, FieldNode>): void {
  let flow = initialFlow(m.sourcePath, m.targetPath, sourceFields);
  for (const step of m.transforms) {
    if (step.disabled) continue;
    for (const error of validateStep(step)) {
      out.add(
        'transform-invalid',
        'error',
        m.targetPath,
        error,
        'Revise a configuração da etapa em Properties.',
        m.id,
      );
    }
    const def = getTransform(step.transformId);
    if (!def) continue;
    const staticType =
      def.kind === 'scalar' && flow.type === 'array' ? (flow.itemType ?? 'any') : flow.type;
    if (
      def.accepts !== 'any' &&
      flow.type !== 'any' &&
      !def.accepts.includes(staticType) &&
      staticType !== 'any'
    ) {
      out.add(
        'transform-invalid',
        def.kind === 'array' ? 'error' : 'warning',
        m.targetPath,
        `${def.label} não aceita entrada do tipo ${staticType}.`,
        def.kind === 'array'
          ? 'Use um caminho com [*] ou uma etapa que produza uma lista antes desta.'
          : 'Converta o valor antes desta etapa ou troque a transformação.',
        m.id,
      );
    }
    flow = flowStep(flow, step);
  }
}

function checkArrays(
  out: Collector,
  m: Mapping,
  srcSegs: PathSegment[],
  tgtSegs: PathSegment[],
  sourceNode: FieldNode | undefined,
  targetNode: FieldNode | undefined,
): void {
  const s = countWildcards(srcSegs);
  const t = countWildcards(tgtSegs);
  const steps = m.transforms.filter((x) => !x.disabled);
  if (s > t) {
    const flow = steps.reduce(flowStep, {
      type: 'array',
      itemType: sourceNode?.type ?? 'any',
    } as TypeFlow);
    if (
      flow.type === 'array' &&
      targetNode &&
      targetNode.type !== 'array' &&
      targetNode.type !== 'any'
    ) {
      out.add(
        'array-incompatible',
        'error',
        m.targetPath,
        `A origem tem ${s} nível(is) de array e o destino ${t}, mas "${m.targetPath}" (${targetNode.type}) não é uma lista.`,
        'Adicione uma agregação (Sum, Count, First...) ou aponte para um destino com [*].',
        m.id,
      );
    }
  } else if (t > s) {
    out.add(
      'array-incompatible',
      'info',
      m.targetPath,
      `A origem tem menos níveis de array que o destino: o valor será copiado para todas as linhas de "${wildcardPrefixes(m.targetPath)[s]}".`,
      'Garanta que outro mapeamento crie as linhas desse array.',
      m.id,
    );
  } else if (
    s === 0 &&
    sourceNode?.type === 'array' &&
    targetNode &&
    targetNode.type !== 'array' &&
    targetNode.type !== 'any'
  ) {
    const flow = steps.reduce(flowStep, {
      type: 'array',
      itemType: sourceNode.itemType,
    } as TypeFlow);
    if (flow.type === 'array') {
      out.add(
        'array-incompatible',
        'error',
        m.targetPath,
        `A origem é uma lista e o destino "${m.targetPath}" é ${targetNode.type}.`,
        'Adicione uma agregação ou mapeie um campo do item com [*].',
        m.id,
      );
    }
  }
}

function checkTypes(
  out: Collector,
  m: Mapping,
  sourceNode: FieldNode | undefined,
  targetNode: FieldNode | undefined,
  sourceFields: Map<string, FieldNode>,
): void {
  if (!targetNode) return;
  if (!sourceNode && m.sourcePath !== '') return;
  const flow =
    m.sourcePath === ''
      ? m.transforms.reduce(flowStep, { type: 'any' } as TypeFlow)
      : pipelineOutputType(m, sourceFields);
  if (flow.type === 'array' && targetNode.type !== 'array') return; // tratado em checkArrays
  if (
    flow.type === 'array' &&
    targetNode.type === 'array' &&
    flow.itemType &&
    targetNode.itemType
  ) {
    compare(out, m, flow.itemType, targetNode.itemType);
    return;
  }
  compare(out, m, flow.type, targetNode.type);
}

function compare(out: Collector, m: Mapping, from: FieldType, to: FieldType): void {
  const compat = typeCompatibility(from, to);
  if (compat === 'incompatible') {
    out.add(
      'type-incompatible',
      'error',
      m.targetPath,
      `Tipo incompatível: ${from} em "${m.sourcePath || 'constante'}" não pode ser atribuído a ${to} em "${m.targetPath}".`,
      'Adicione uma transformação de conversão ou altere o campo de destino.',
      m.id,
    );
  } else if (compat === 'lossy') {
    out.add(
      'unsafe-conversion',
      'warning',
      m.targetPath,
      `Conversão potencialmente perigosa: ${from} → ${to} pode falhar ou perder informação.`,
      `Use uma transformação explícita para ${to} e trate os valores inválidos.`,
      m.id,
    );
  }
}

function checkConditions(out: Collector, m: Mapping, srcSegs: PathSegment[]): void {
  for (const c of m.conditions ?? []) {
    const segs = safeSegments(c.field);
    if (!segs) {
      out.add(
        'transform-invalid',
        'error',
        m.targetPath,
        `Condição com caminho inválido: "${c.field}".`,
        'Corrija o caminho da condição.',
        m.id,
      );
    } else if (countWildcards(segs) > countWildcards(srcSegs)) {
      out.add(
        'array-incompatible',
        'warning',
        m.targetPath,
        `A condição em "${c.field}" percorre mais arrays que a origem do mapeamento: o valor comparado é uma lista.`,
        'Use um campo no mesmo nível de array da origem.',
        m.id,
      );
    }
  }
}

function checkNullData(
  out: Collector,
  m: Mapping,
  data: JsonValue | undefined,
  sourceNode: FieldNode | undefined,
  targetNode: FieldNode | undefined,
  srcSegs: PathSegment[],
): void {
  if (data === undefined || m.sourcePath === '' || m.defaultValue !== undefined) return;
  if (m.transforms.some((t) => !t.disabled && getTransform(t.transformId)?.handlesNull)) return;
  if (!targetNode?.required && targetNode?.nullable !== false) return;
  const value = getIn(data, m.sourcePath);
  const hasNull =
    Array.isArray(value) && srcSegs.some((s) => s.kind === 'wildcard')
      ? value.some((v) => isNil(v))
      : isNil(value);
  if (hasNull) {
    out.add(
      'unexpected-null',
      'warning',
      m.targetPath,
      `"${m.sourcePath}" tem valor nulo ou ausente nos dados, mas "${m.targetPath}" não admite nulo.`,
      'Defina um valor padrão ou use a transformação Null Handling.',
      m.id,
    );
  }
  void sourceNode;
}

function checkDuplicates(out: Collector, mappings: readonly Mapping[]): void {
  const byTarget = new Map<string, Mapping[]>();
  for (const m of mappings) byTarget.set(m.targetPath, [...(byTarget.get(m.targetPath) ?? []), m]);
  for (const [target, group] of byTarget) {
    if (group.length < 2) continue;
    // Com condições, é legítimo ter mais de uma origem para o mesmo destino.
    const conditional = group.every((m) => (m.conditions?.length ?? 0) > 0);
    const identical = new Set(group.map((m) => m.sourcePath)).size < group.length;
    for (const m of group.slice(1)) {
      out.add(
        'duplicate-mapping',
        conditional && !identical ? 'info' : 'error',
        target,
        identical
          ? `Mapeamento duplicado: "${m.sourcePath}" → "${target}" aparece mais de uma vez.`
          : `"${target}" recebe valores de ${group.length} mapeamentos; o último a escrever prevalece.`,
        'Remova os mapeamentos excedentes ou use condições exclusivas.',
        m.id,
      );
    }
  }
}

function checkPathConflicts(out: Collector, mappings: readonly Mapping[]): void {
  const parsed = mappings.flatMap((m) => {
    const segs = safeSegments(m.targetPath);
    return segs ? [{ m, segs }] : [];
  });
  for (const a of parsed) {
    for (const b of parsed) {
      if (a === b || a.segs.length >= b.segs.length) continue;
      const prefix = b.segs.slice(0, a.segs.length);
      if (formatPath(prefix) === formatPath(a.segs)) {
        out.add(
          'path-conflict',
          'error',
          a.m.targetPath,
          `Conflito de caminhos: "${a.m.targetPath}" recebe um valor inteiro e "${b.m.targetPath}" escreve dentro dele.`,
          'Mapeie o objeto inteiro ou seus campos, não ambos.',
          b.m.id,
        );
      }
    }
  }
}

/** Um array de destino só pode ser alimentado por um array de origem. */
function checkArraySources(out: Collector, mappings: readonly Mapping[]): void {
  const feeders = new Map<string, Map<string, string>>();
  for (const m of mappings) {
    const src = safeSegments(m.sourcePath);
    const tgt = safeSegments(m.targetPath);
    if (!src || !tgt) continue;
    const sp = wildcardPrefixes(m.sourcePath);
    const tp = wildcardPrefixes(m.targetPath);
    const aligned = Math.min(sp.length, tp.length);
    for (let i = 0; i < aligned; i++) {
      const map = feeders.get(tp[i]) ?? new Map<string, string>();
      if (!map.has(sp[i])) map.set(sp[i], m.id);
      feeders.set(tp[i], map);
    }
  }
  for (const [target, sources] of feeders) {
    if (sources.size > 1) {
      const names = [...sources.keys()];
      out.add(
        'array-incompatible',
        'error',
        target,
        `"${target}" é alimentado por arrays diferentes (${names.join(', ')}): os elementos de posições iguais seriam misturados.`,
        'Use um único array de origem para cada array de destino.',
        [...sources.values()][1],
      );
    }
  }
}

/** Ciclos entre mapeamentos: a origem de um é o destino de outro (a → b, b → a). */
function checkCircular(out: Collector, mappings: readonly Mapping[]): void {
  const edges = new Map<string, Mapping[]>();
  for (const m of mappings) {
    if (m.sourcePath === '') continue;
    edges.set(m.sourcePath, [...(edges.get(m.sourcePath) ?? []), m]);
  }
  const reported = new Set<string>();
  const dfs = (node: string, trail: string[], ids: Mapping[]): void => {
    for (const m of edges.get(node) ?? []) {
      const at = trail.indexOf(m.targetPath);
      if (at >= 0) {
        const cycle = [...trail.slice(at), m.targetPath];
        const key = [...new Set(cycle)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          out.add(
            'circular-reference',
            'warning',
            m.targetPath,
            `Referência circular entre mapeamentos: ${cycle.join(' → ')}.`,
            'Como cada execução lê apenas da origem, confirme se a estrutura de destino é mesmo igual à de origem.',
            m.id,
          );
        }
      } else if (trail.length < 64) {
        dfs(m.targetPath, [...trail, m.targetPath], [...ids, m]);
      }
    }
  };
  for (const start of edges.keys()) dfs(start, [start], []);
}

function checkScopes(
  out: Collector,
  scopes: readonly ArrayScope[],
  mappings: readonly Mapping[],
  sourceFields: Map<string, FieldNode>,
): void {
  for (const scope of scopes) {
    const used = mappings.some(
      (m) =>
        wildcardPrefixes(m.sourcePath).includes(scope.sourcePath) &&
        wildcardPrefixes(m.targetPath).includes(scope.targetPath),
    );
    if (!used) {
      out.add(
        'array-incompatible',
        'info',
        scope.targetPath,
        `O escopo ${scope.sourcePath} → ${scope.targetPath} não corresponde a nenhum mapeamento e será ignorado.`,
        'Remova o escopo ou crie mapeamentos entre esses arrays.',
      );
    }
    for (const field of [
      ...(scope.filter ?? []).map((c) => c.field),
      scope.sort?.field,
      scope.distinctBy,
    ]) {
      if (field && !sourceFields.has(`${scope.sourcePath}.${field}`) && sourceFields.size > 0) {
        out.add(
          'source-missing',
          'warning',
          scope.sourcePath,
          `O escopo usa o campo "${field}", que não existe em ${scope.sourcePath}.`,
          'Corrija o campo do filtro, da ordenação ou do distinct.',
        );
      }
    }
  }
}

function checkRequired(
  out: Collector,
  mappings: readonly Mapping[],
  targetRoot: FieldNode | null,
): void {
  const mapped = mappings.map((m) => m.targetPath);
  for (const field of flattenFields(targetRoot)) {
    if (!field.required || field.name === '[*]') continue;
    const covered = mapped.some(
      (p) => p === field.path || p.startsWith(`${field.path}.`) || p.startsWith(`${field.path}[`),
    );
    if (covered || !parentIsPresent(field.path, mapped)) continue;
    out.add(
      'required-unfilled',
      'error',
      field.path,
      `O campo obrigatório "${field.path}" não recebe nenhum valor.`,
      'Conecte um campo de origem ou defina uma constante.',
    );
  }
}

/** Filhos obrigatórios de um objeto opcional só contam se o objeto for preenchido. */
function parentIsPresent(path: string, mapped: string[]): boolean {
  const segs = parsePath(path);
  const parent = formatPath(segs.slice(0, -1));
  if (segs.length <= 1 || parent === '') return true;
  return mapped.some(
    (p) => p === parent || p.startsWith(`${parent}.`) || p.startsWith(`${parent}[`),
  );
}

/** Atualiza o status de validação dos mapeamentos a partir dos diagnósticos. */
export function statusFromDiagnostics(
  mappingId: string,
  diagnostics: readonly Diagnostic[],
): ValidationStatus {
  const own = diagnostics.filter((d) => d.mappingId === mappingId);
  if (own.some((d) => d.severity === 'error')) return 'error';
  if (own.some((d) => d.severity === 'warning')) return 'warning';
  return 'valid';
}

/** Conveniência para quem tem só o documento do projeto (dashboard, testes, exemplos). */
export function diagnoseDocument(
  doc: ProjectDocument,
  limits: ParseLimits = DEFAULT_LIMITS,
): Diagnostic[] {
  const sample = parseJsonSafe(doc.sampleData, limits);
  return runDiagnostics({
    mappings: doc.mappings,
    scopes: doc.scopes,
    source: parseStructure(doc.source, limits),
    target: parseStructure(doc.target, limits),
    sampleData: sample.ok ? sample.value : undefined,
    sampleError: sample.ok ? undefined : sample.message,
  });
}
