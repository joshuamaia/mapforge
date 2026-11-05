import { JsonValue } from '../models/json.model';
import { Condition, Mapping, TransformStep } from '../models/mapping.model';
import { FieldNode } from '../models/schema.model';
import { CodegenSettings, ProjectDocument } from '../models/project.model';
import {
  parsePathOrEmpty,
  PathSegment,
  wildcardPrefixes,
  formatPath,
  countWildcards,
} from '../mapping-engine/path';
import { getTransform, pList } from '../transformations/catalog';
import runtimeTemplate from './templates/runtime.ts.txt';
import {
  buildPlan,
  camelCase,
  hasObjectItems,
  kebabCase,
  MappingPlan,
  pascalCase,
  PlanArray,
  PlanLeaf,
  PlanNode,
  PlanObject,
  TypeNamer,
} from './plan';
import { RuntimeSections } from './runtime-sections';
import { GeneratedFile, GeneratedOutput } from './types';
import { CodeWriter } from './writer';

const runtime = new RuntimeSections(runtimeTemplate);

const lit = (v: JsonValue | undefined): string =>
  v === undefined ? 'undefined' : JSON.stringify(v);
const SAFE_PROP = /^[A-Za-z_$][\w$]*$/;
const access = (base: string, key: string): string =>
  SAFE_PROP.test(key) ? `${base}?.${key}` : `${base}?.[${JSON.stringify(key)}]`;
const assignTo = (base: string, key: string): string =>
  SAFE_PROP.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

/** Vínculo entre um `[*]` da origem e a variável do laço corrente. */
interface Scope {
  bindings: Map<string, string>;
}

class TsEmitter {
  private counter = 0;
  readonly w = new CodeWriter();

  constructor(
    private readonly plan: MappingPlan,
    private readonly namer: TypeNamer,
    private readonly comments: boolean,
  ) {}

  private fresh(prefix: string): string {
    this.counter++;
    return `${prefix}${this.counter}`;
  }

  /** Expressão de leitura de um caminho de origem, no contexto dos laços abertos. */
  read(segs: readonly PathSegment[], scope: Scope, filter?: readonly Condition[]): string {
    return this.readFrom('source', segs, 0, 0, scope, '', filter);
  }

  private readFrom(
    base: string,
    segs: readonly PathSegment[],
    pos: number,
    level: number,
    scope: Scope,
    prefix: string,
    filter?: readonly Condition[],
  ): string {
    let expr = base;
    for (let i = pos; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.kind === 'prop') {
        expr = access(expr, seg.name);
      } else if (seg.kind === 'index') {
        expr = `${expr}?.[${seg.index}]`;
      } else {
        const prefixPath = formatPath(segs.slice(0, i + 1));
        const bound = scope.bindings.get(prefixPath);
        if (bound) {
          expr = bound;
          continue;
        }
        const item = this.fresh('it');
        const inner: Scope = { bindings: new Map(scope.bindings).set(prefixPath, item) };
        const rest = this.readFrom(item, segs, i + 1, level + 1, inner, prefixPath, filter);
        const hasMore = segs.slice(i + 1).some((s) => s.kind === 'wildcard');
        if (hasMore) return `collectFlat(${expr}, (${item}: any) => ${rest})`;
        const conditions = (filter ?? []).map((c) => this.condition(c, inner));
        const body = conditions.length ? `(${conditions.join(' && ')}) ? ${rest} : SKIP` : rest;
        return `collect(${expr}, (${item}: any) => ${body})`;
      }
    }
    return expr;
  }

  condition(c: Condition, scope: Scope): string {
    const value = this.read(parsePathOrEmpty(c.field), scope);
    return `evaluate(${value}, ${lit(c.operator)}, ${lit(c.value)})`;
  }

  /** Acesso relativo a um item, usado por escopos e etapas de lista. */
  private itemField(field: string): string {
    if (field === '') return '(x: any) => x';
    let expr = 'x';
    for (const seg of parsePathOrEmpty(field)) {
      if (seg.kind === 'prop') expr = access(expr, seg.name);
      else if (seg.kind === 'index') expr = `${expr}?.[${seg.index}]`;
    }
    return `(x: any) => ${expr}`;
  }

  private step(step: TransformStep, scope: Scope): string {
    const p = step.params;
    const s = (key: string, fallback = ''): string => {
      const v = p[key];
      return JSON.stringify(
        v === undefined || v === null ? fallback : typeof v === 'string' ? v : JSON.stringify(v),
      );
    };
    const b = (key: string, fallback: boolean): string =>
      String(typeof p[key] === 'boolean' ? p[key] : fallback);
    const n = (key: string, fallback: number): string => {
      const v = p[key];
      return String(v === undefined || v === '' || v === null ? fallback : Number(v));
    };
    const nOrNull = (key: string): string => {
      const v = p[key];
      return v === undefined || v === '' || v === null ? 'null' : String(Number(v));
    };
    const field = this.itemField(typeof p['field'] === 'string' ? p['field'] : '');
    const others = (key: string): string =>
      `[${pList(p, key)
        .map((f) => this.read(parsePathOrEmpty(f), scope))
        .join(', ')}]`;
    const list = (key: string, fallback: string): string => {
      const items = pList(p, key).length ? pList(p, key) : fallback.split(',');
      return JSON.stringify(items.map((x) => x.toLowerCase()));
    };
    switch (step.transformId) {
      case 'uppercase':
        return 'lift(v, (x) => uppercase(x))';
      case 'lowercase':
        return 'lift(v, (x) => lowercase(x))';
      case 'trim':
        return 'lift(v, (x) => trim(x))';
      case 'capitalize':
        return `lift(v, (x) => capitalize(x, ${b('allWords', true)}))`;
      case 'replace':
        return `lift(v, (x) => replaceText(x, ${s('search')}, ${s('replacement')}, ${b('regex', false)}, ${b('all', true)}))`;
      case 'substring':
        return `lift(v, (x) => substringOf(x, ${n('start', 0)}, ${nOrNull('end')}))`;
      case 'split':
        return `lift(v, (x) => splitText(x, ${s('separator', ',')}))`;
      case 'join':
        return `joinList(v, ${s('separator', ', ')})`;
      case 'concat':
        return `liftNullable(v, (x) => concatText(x, ${s('prefix')}, ${s('suffix')}, ${s('separator')}, ${others('fields')}))`;
      case 'removeAccents':
        return 'lift(v, (x) => removeAccents(x))';
      case 'padStart':
        return `lift(v, (x) => padStartText(x, ${n('length', 0)}, ${s('char', ' ')}))`;
      case 'padEnd':
        return `lift(v, (x) => padEndText(x, ${n('length', 0)}, ${s('char', ' ')}))`;
      case 'stringToNumber':
        return `lift(v, (x) => stringToNumber(x, ${s('decimalSeparator', '.')}))`;
      case 'numberToString':
        return `lift(v, (x) => numberToText(x, ${nOrNull('digits')}))`;
      case 'round':
        return `lift(v, (x) => roundTo(x, ${n('digits', 0)}))`;
      case 'floor':
        return 'lift(v, (x) => floorOf(x))';
      case 'ceil':
        return 'lift(v, (x) => ceilOf(x))';
      case 'abs':
        return 'lift(v, (x) => absOf(x))';
      case 'multiply':
        return `lift(v, (x) => multiply(x, ${n('operand', 0)}))`;
      case 'divide':
        return `lift(v, (x) => divide(x, ${n('operand', 0)}))`;
      case 'add':
        return `lift(v, (x) => add(x, ${n('operand', 0)}))`;
      case 'subtract':
        return `lift(v, (x) => subtract(x, ${n('operand', 0)}))`;
      case 'precision':
        return `lift(v, (x) => precisionOf(x, ${n('digits', 0)}))`;
      case 'stringToDate':
        return `lift(v, (x) => stringToDate(x, ${s('pattern')}))`;
      case 'dateToString':
        return `lift(v, (x) => dateToText(x, ${s('pattern')}))`;
      case 'toIso8601':
        return `lift(v, (x) => toIso8601(x, ${s('timeZone', 'UTC')}))`;
      case 'formatDate':
        return `lift(v, (x) => formatDate(x, ${s('inputPattern')}, ${s('pattern')}))`;
      case 'convertTimezone':
        return `lift(v, (x) => convertTimezone(x, ${s('from', 'UTC')}, ${s('to')}))`;
      case 'datePart':
        return `lift(v, (x) => datePart(x, ${s('part', 'year')}))`;
      case 'isValidDate':
        return `lift(v, (x) => isValidDate(x, ${s('pattern')}))`;
      case 'stringToBoolean':
        return `lift(v, (x) => stringToBoolean(x, ${list('trueValues', 'true,1,yes,y,sim,s')}, ${list('falseValues', 'false,0,no,n,nao,não')}))`;
      case 'numberToBoolean':
        return 'lift(v, (x) => numberToBoolean(x))';
      case 'booleanToString':
        return `lift(v, (x) => booleanToText(x, ${s('trueLabel', 'true')}, ${s('falseLabel', 'false')}))`;
      case 'defaultValue':
        return `defaultValue(v, ${lit(p['value'] ?? null)}, ${b('emptyAsNull', false)})`;
      case 'coalesce':
        return `coalesce(v, ${others('paths')})`;
      case 'conditional':
        return `liftNullable(v, (x) => conditional(x, ${s('operator', 'eq')}, ${lit(p['compare'])}, ${lit(p['thenValue'])}, ${lit(p['elseValue'])}))`;
      case 'constant':
        return lit(p['value'] ?? null);
      case 'lookup':
        return `lift(v, (x) => lookup(x, ${lit(p['table'] ?? {})}, ${lit(p['fallback'])}, ${b('keepUnmatched', false)}))`;
      case 'enumMap':
        return `lift(v, (x) => enumMap(x, ${lit(p['table'] ?? {})}, ${b('strict', true)}))`;
      case 'nullHandling':
        return `nullHandling(v, ${s('mode', 'omit')})`;
      case 'removeEmpty':
        return 'removeEmpty(v)';
      case 'filter':
        return `filterList(v, ${field}, ${s('operator', 'eq')}, ${lit(p['value'])})`;
      case 'map':
        return `mapList(v, ${field})`;
      case 'distinct':
        return `distinctList(v, ${field})`;
      case 'sort':
        return `sortList(v, ${field}, ${s('direction', 'asc') === '"desc"'})`;
      case 'count':
        return 'countList(v)';
      case 'sum':
        return `sumList(v, ${field})`;
      case 'average':
        return `averageList(v, ${field})`;
      case 'min':
        return `extreme(v, ${field}, -1)`;
      case 'max':
        return `extreme(v, ${field}, 1)`;
      case 'first':
        return 'firstOf(v)';
      case 'last':
        return 'lastOf(v)';
      default:
        throw new Error(`Transformação sem gerador TypeScript: ${step.transformId}`);
    }
  }

  /** Abre um bloco que deixa em `v` o valor do mapeamento e chama `write(v)`. */
  private leaf(leaf: PlanLeaf, scope: Scope, write: (value: string) => string): void {
    const m = leaf.mapping;
    const w = this.w;
    if (this.comments) w.line(`// ${m.sourcePath || '(sem origem)'} -> ${m.targetPath}`);
    const excess =
      countWildcards(leaf.sourceSegs) -
      [...scope.bindings.keys()].filter((k) => wildcardPrefixes(m.sourcePath).includes(k)).length;
    const conditions = m.conditions ?? [];
    const rowConditions = excess > 0 ? [] : conditions.map((c) => this.condition(c, scope));
    const read =
      m.sourcePath === ''
        ? 'undefined'
        : this.read(leaf.sourceSegs, scope, excess > 0 ? conditions : undefined);
    const steps = m.transforms.filter((t) => !t.disabled);

    w.open(rowConditions.length ? `if (${rowConditions.join(' && ')}) {` : '{');
    w.line(`let v: unknown = ${read};`);
    for (const step of steps) w.line(`v = ${this.step(step, scope)};`);
    if (m.defaultValue !== undefined) w.line(`if (isNil(v)) v = ${lit(m.defaultValue)};`);
    w.line(`if (v !== undefined) ${write('v')};`);
    w.close();
  }

  private object(plan: PlanObject, varName: string, scope: Scope): void {
    for (const [key, child] of plan.children) {
      if (child.kind === 'leaf') {
        this.leaf(child, scope, (v) => `${assignTo(varName, key)} = ${v} as never`);
      } else if (child.kind === 'object') {
        const name = this.fresh(camelCase(key) || 'obj');
        const typeName = child.node ? this.namer.nameOf(child.node) : 'Record<string, unknown>';
        this.w.line(`const ${name}: Partial<${typeName}> = {};`);
        this.object(child, name, scope);
        this.w.line(
          `if (Object.keys(${name}).length > 0) ${assignTo(varName, key)} = ${name} as never;`,
        );
      } else {
        this.array(child, scope, (v) => `${assignTo(varName, key)} = ${v} as never`);
      }
    }
  }

  private array(plan: PlanArray, scope: Scope, assign: (value: string) => string): void {
    const w = this.w;
    const prefix = plan.sourcePrefix as string;
    const segs = parsePathOrEmpty(prefix);
    const arrayExpr = this.read(segs.slice(0, -1), scope);
    const rows = this.fresh('rows');
    const out = this.fresh('out');
    const item = this.fresh('item');
    const index = this.fresh('i');
    if (this.comments) w.line(`// Cada item de ${prefix} gera uma linha.`);
    w.line(`const ${rows} = asArray(${arrayExpr});`);
    w.open(`if (${rows} !== undefined) {`);
    w.line(`const ${out}: unknown[] = [];`);
    const selected = plan.scope ? `selectRows(${rows}, ${this.scopeOptions(plan)})` : rows;
    w.line(`let ${index} = 0;`);
    w.open(`for (const ${item} of ${selected} as readonly any[]) {`);
    const inner: Scope = { bindings: new Map(scope.bindings).set(prefix, item) };
    const child = plan.item as PlanNode;
    if (child.kind === 'leaf') {
      this.leaf(child, inner, (v) => `setAt(${out}, ${index}, ${v})`);
    } else if (child.kind === 'object') {
      const row = this.fresh('row');
      w.line(`const ${row}: any = {};`);
      this.object(child, row, inner);
      w.line(`${out}[${index}] = ${row};`);
    } else {
      this.array(child, inner, (v) => `setAt(${out}, ${index}, ${v})`);
    }
    w.line(`${index}++;`);
    w.close();
    w.line(`${assign(out)};`);
    w.close();
  }

  private scopeOptions(plan: PlanArray): string {
    const s = plan.scope;
    if (!s) return '{}';
    const parts: string[] = [];
    if (s.filter?.length) {
      const checks = s.filter.map(
        (c) => `evaluate((${this.itemField(c.field)})(x), ${lit(c.operator)}, ${lit(c.value)})`,
      );
      parts.push(`filter: (x: any) => ${checks.join(' && ')}`);
    }
    if (s.distinctBy) parts.push(`distinct: ${this.itemField(s.distinctBy)}`);
    if (s.sort) {
      parts.push(`sort: ${this.itemField(s.sort.field)}`);
      parts.push(`desc: ${s.sort.direction === 'desc'}`);
    }
    return `{ ${parts.join(', ')} }`;
  }

  body(root: PlanObject | PlanArray, targetType: string): void {
    const w = this.w;
    const scope: Scope = { bindings: new Map() };
    if (root.kind === 'object') {
      w.line(`const target: Partial<${targetType}> = {};`);
      this.object(root, 'target', scope);
      w.line(`return target as ${targetType};`);
    } else {
      w.line('let target: unknown = {};');
      if (root.sourcePrefix) this.array(root, scope, (v) => `target = ${v}`);
      w.line(`return target as ${targetType};`);
    }
  }
}

function tsType(node: FieldNode, namer: TypeNamer): string {
  let base: string;
  switch (node.type) {
    case 'string':
    case 'date':
    case 'datetime':
      base = 'string';
      break;
    case 'number':
    case 'integer':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'enum':
      base = node.enumValues?.length
        ? node.enumValues.map((v) => JSON.stringify(v)).join(' | ')
        : 'string';
      break;
    case 'object':
      base = namer.nameOf(node);
      break;
    case 'array': {
      const children = node.children ?? [];
      if (children.length === 0) base = 'unknown[]';
      else if (hasObjectItems(node)) base = `${namer.nameOf(node)}[]`;
      else {
        const inner = tsType(children[0], namer);
        base = inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
      }
      break;
    }
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
  return node.nullable ? `${base} | null` : base;
}

export function emitInterfaces(
  root: FieldNode | null,
  namer: TypeNamer,
  comments: boolean,
  declared: Set<string>,
): string {
  const w = new CodeWriter();
  if (!root) return '';
  for (const node of namer.declarations(root)) {
    const name = namer.nameOf(node);
    if (declared.has(name)) continue;
    declared.add(name);
    if (node.path === '' && node.type === 'array' && !hasObjectItems(node)) continue;
    if (comments && node.path !== '') w.line(`/** Estrutura de \`${node.path}\`. */`);
    w.open(`export interface ${name} {`);
    for (const c of node.children ?? []) {
      const key = SAFE_PROP.test(c.name) ? c.name : JSON.stringify(c.name);
      w.line(`${key}${c.required ? '' : '?'}: ${tsType(c, namer)};`);
    }
    w.close();
    w.line();
  }
  return w.toString().trimEnd();
}

export function rootTypeName(root: FieldNode | null, namer: TypeNamer, fallback: string): string {
  if (!root) return fallback;
  if (root.type === 'array') return `${tsType(root, namer)}`;
  return namer.nameOf(root);
}

function functionName(settings: CodegenSettings): string {
  const base = camelCase(settings.mapperName) || 'dataMapper';
  return `map${pascalCase(base)}`;
}

/** Corpo comum: interfaces, função de mapeamento e runtime usado. */
function mappingCode(
  doc: ProjectDocument,
  plan: MappingPlan,
  settings: CodegenSettings,
): { code: string; sourceType: string; targetType: string; fn: string } {
  const namer = new TypeNamer(
    plan.source.root,
    plan.target.root,
    plan.source.rootName,
    plan.target.rootName,
  );
  const declared = new Set<string>();
  const interfaces = [
    emitInterfaces(plan.source.root, namer, settings.comments, declared),
    emitInterfaces(plan.target.root, namer, settings.comments, declared),
  ].filter((x) => x !== '');
  const sourceType = rootTypeName(plan.source.root, namer, 'unknown');
  const targetType = rootTypeName(plan.target.root, namer, 'Record<string, unknown>');
  const emitter = new TsEmitter(plan, namer, settings.comments);
  const fn = functionName(settings);
  const w = emitter.w;
  if (settings.comments) {
    w.line(`/**`);
    w.line(` * Converte ${plan.source.rootName} em ${plan.target.rootName}. Não altera a entrada.`);
    w.line(` * Valores inválidos resultam em null e campos ausentes não são escritos.`);
    w.line(` */`);
  }
  w.open(`export function ${fn}(source: ${sourceType}): ${targetType} {`);
  emitter.body(plan.root, targetType);
  w.close();
  const body = w.toString();
  const helpers = runtime.select(body).join('\n\n');
  void doc;
  const sections = [...interfaces, body.trimEnd()];
  if (helpers) {
    sections.push(
      `${settings.comments ? '// ---- Funções auxiliares geradas pelo MapForge ----\n\n' : ''}${helpers}`,
    );
  }
  return { code: sections.join('\n\n') + '\n', sourceType, targetType, fn };
}

const LINT_HEADER = '/* eslint-disable @typescript-eslint/no-explicit-any */\n';

export function generateTypeScript(
  doc: ProjectDocument,
  settings: CodegenSettings,
): GeneratedOutput {
  const plan = buildPlan(doc);
  const { code } = mappingCode(doc, plan, settings);
  const file: GeneratedFile = {
    name: `${kebabCase(settings.mapperName) || 'data-mapper'}.ts`,
    language: 'typescript',
    content: LINT_HEADER + code,
  };
  return { files: [file], warnings: plan.warnings };
}

export function generateAngularService(
  doc: ProjectDocument,
  settings: CodegenSettings,
): GeneratedOutput {
  const plan = buildPlan(doc);
  const { code, sourceType, targetType, fn } = mappingCode(doc, plan, settings);
  const className = pascalCase(settings.mapperName).replace(/Service$/, '') + 'Service';
  const w = new CodeWriter();
  w.line(LINT_HEADER.trimEnd());
  w.line("import { Injectable } from '@angular/core';");
  w.line();
  w.block(code.trimEnd());
  w.line();
  if (settings.comments)
    w.line(
      `/** Serviço Angular com as transformações de ${plan.source.rootName} para ${plan.target.rootName}. */`,
    );
  w.line("@Injectable({ providedIn: 'root' })");
  w.open(`export class ${className} {`);
  w.open(`map(source: ${sourceType}): ${targetType} {`);
  w.line(`return ${fn}(source);`);
  w.close();
  w.line();
  w.open(`mapList(sources: readonly (${sourceType})[] | null | undefined): (${targetType})[] {`);
  w.line(`return (sources ?? []).map((source) => ${fn}(source));`);
  w.close();
  w.close();
  const file: GeneratedFile = {
    name: `${kebabCase(className.replace(/Service$/, '')) || 'data-mapper'}.service.ts`,
    language: 'typescript',
    content: w.toString(),
  };
  return { files: [file], warnings: plan.warnings };
}

export function generateTsInterfaces(
  doc: ProjectDocument,
  settings: CodegenSettings,
): GeneratedOutput {
  const plan = buildPlan(doc);
  const namer = new TypeNamer(
    plan.source.root,
    plan.target.root,
    plan.source.rootName,
    plan.target.rootName,
  );
  const declared = new Set<string>();
  const sections = [
    emitInterfaces(plan.source.root, namer, settings.comments, declared),
    emitInterfaces(plan.target.root, namer, settings.comments, declared),
  ].filter((x) => x !== '');
  return {
    files: [{ name: 'models.ts', language: 'typescript', content: sections.join('\n\n') + '\n' }],
    warnings: [],
  };
}
