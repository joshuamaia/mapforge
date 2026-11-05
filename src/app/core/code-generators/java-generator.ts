import { JsonValue } from '../models/json.model';
import { Condition, TransformStep } from '../models/mapping.model';
import { CodegenSettings, ProjectDocument } from '../models/project.model';
import { FieldNode } from '../models/schema.model';
import {
  countWildcards,
  formatPath,
  parsePathOrEmpty,
  PathSegment,
  wildcardPrefixes,
} from '../mapping-engine/path';
import { getTransform, pList } from '../transformations/catalog';
import { indexFields } from '../parsers/structure';
import runtimeTemplate from './templates/runtime.java.txt';
import {
  boxed,
  getterName,
  importsFor,
  isPrimitive,
  javaClassFileName,
  javaFieldName,
  javaString,
  javaType,
  setterName,
} from './java-model';
import {
  buildPlan,
  hasObjectItems,
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

export class UnsupportedInJava extends Error {}

export function javaLiteral(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'string') return javaString(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? `${v}L` : `${v}d`;
  if (Array.isArray(v)) return `List.of(${v.map(javaLiteral).join(', ')})`;
  return `mapOf(${Object.entries(v)
    .flatMap(([k, x]) => [javaString(k), javaLiteral(x)])
    .join(', ')})`;
}

export interface JavaContext {
  /** Prefixos `[*]` vinculados às variáveis dos laços abertos. */
  bindings: Map<string, { variable: string; node?: FieldNode }>;
  /** Raiz da leitura: normalmente `source`. */
  root: string;
}

/** Emissão de leituras, condições e etapas, compartilhada pelo Java puro e pelo MapStruct. */
export class JavaExpressions {
  private counter = 0;
  readonly sourceFields: Map<string, FieldNode>;

  constructor(
    readonly plan: MappingPlan,
    readonly namer: TypeNamer,
    private readonly sourceFromJava: boolean,
    private readonly targetFromJava: boolean,
  ) {
    this.sourceFields = indexFields(plan.source.root);
  }

  fresh(prefix: string): string {
    this.counter++;
    return `${prefix}${this.counter}`;
  }

  private propertyNode(path: string): FieldNode | undefined {
    return this.sourceFields.get(path);
  }

  private normalize(segs: readonly PathSegment[]): string {
    return formatPath(
      segs.map((s): PathSegment => (s.kind === 'index' ? { kind: 'wildcard' } : s)),
    );
  }

  /** Leitura segura contra nulos. O resultado pode ter qualquer tipo; costuma ir para `Object`. */
  read(segs: readonly PathSegment[], ctx: JavaContext, filter?: readonly Condition[]): string {
    return this.readFrom(ctx.root, segs, 0, ctx, filter);
  }

  private readFrom(
    base: string,
    segs: readonly PathSegment[],
    pos: number,
    ctx: JavaContext,
    filter?: readonly Condition[],
  ): string {
    let expr = base;
    let optional = false;
    const wrap = (): void => {
      if (!optional) {
        expr = `Optional.ofNullable(${expr})`;
        optional = true;
      }
    };
    const finish = (): string => (optional ? `${expr}.orElse(null)` : expr);
    let start = pos;
    if (pos === 0) {
      // Parte do laço mais interno já aberto para essa origem.
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].kind !== 'wildcard') continue;
        const bound = ctx.bindings.get(formatPath(segs.slice(0, i + 1)));
        if (bound) {
          expr = bound.variable;
          start = i + 1;
          break;
        }
      }
    }
    for (let i = start; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.kind === 'prop') {
        const node = this.propertyNode(this.normalize(segs.slice(0, i + 1)));
        const getter = node ? getterName(node) : `get${pascalCase(seg.name)}`;
        if (expr === 'source') {
          // A raiz já foi verificada no início do método.
          expr = `source.${getter}()`;
          continue;
        }
        wrap();
        const x = this.fresh('x');
        expr = `${expr}.map(${x} -> ${x}.${getter}())`;
      } else if (seg.kind === 'index') {
        wrap();
        const x = this.fresh('x');
        expr = `${expr}.map(${x} -> ${x}.size() > ${seg.index} ? ${x}.get(${seg.index}) : null)`;
      } else {
        const prefix = formatPath(segs.slice(0, i + 1));
        const item = this.fresh('it');
        const inner: JavaContext = {
          root: ctx.root,
          bindings: new Map(ctx.bindings).set(prefix, {
            variable: item,
            node: this.propertyNode(prefix),
          }),
        };
        const list = finish();
        const rest = this.readFrom(item, segs, i + 1, inner, filter);
        const hasMore = segs.slice(i + 1).some((s) => s.kind === 'wildcard');
        if (hasMore) return `collectFlat(${list}, ${item} -> ${rest})`;
        const conds = (filter ?? []).map((c) => this.condition(c, inner));
        const predicate = conds.length ? `${item} -> ${conds.join(' && ')}` : `${item} -> true`;
        return `collect(${list}, ${predicate}, ${item} -> ${rest})`;
      }
    }
    return finish();
  }

  condition(c: Condition, ctx: JavaContext): string {
    return `evaluate(${this.read(parsePathOrEmpty(c.field), ctx)}, ${javaString(c.operator)}, ${javaLiteral(c.value)})`;
  }

  /** Leitor de campo de um item de lista, com o cast para a classe conhecida. */
  itemField(field: string, element: FieldNode | undefined, what: string): string {
    if (field === '') return 'x -> x';
    if (!element) {
      throw new UnsupportedInJava(
        `${what} usa o campo "${field}" de itens cuja classe não é conhecida.`,
      );
    }
    const typeName = this.elementClass(element);
    let expr = `Optional.ofNullable((${typeName}) x)`;
    let node: FieldNode | undefined = element;
    for (const seg of parsePathOrEmpty(field)) {
      if (seg.kind !== 'prop')
        throw new UnsupportedInJava(`${what}: caminho "${field}" com lista.`);
      node = node?.children?.find((c) => c.name === seg.name);
      if (!node) throw new UnsupportedInJava(`${what}: campo "${field}" não existe no item.`);
      const y = this.fresh('y');
      expr = `${expr}.map(${y} -> ${y}.${getterName(node)}())`;
    }
    return `x -> ${expr}.orElse(null)`;
  }

  private elementClass(element: FieldNode): string {
    return this.sourceFromJava && element.typeName ? element.typeName : this.namer.nameOf(element);
  }

  private fieldChild(element: FieldNode | undefined, field: string): FieldNode | undefined {
    let node = element;
    for (const seg of parsePathOrEmpty(field)) {
      if (seg.kind !== 'prop') return undefined;
      node = node?.children?.find((c) => c.name === seg.name);
    }
    return node;
  }

  /** Emite as etapas e acompanha a classe dos itens, necessária para ler campos em Java. */
  step(step: TransformStep, ctx: JavaContext, state: { element?: FieldNode }): string {
    const p = step.params;
    const label = getTransform(step.transformId)?.label ?? step.transformId;
    const s = (key: string, fallback = ''): string => {
      const v = p[key];
      return javaString(
        v === undefined || v === null ? fallback : typeof v === 'string' ? v : JSON.stringify(v),
      );
    };
    const b = (key: string, fallback: boolean): string =>
      String(typeof p[key] === 'boolean' ? p[key] : fallback);
    const n = (key: string, fallback: number): string => {
      const v = p[key];
      return String(v === undefined || v === '' || v === null ? fallback : Number(v));
    };
    const dbl = (key: string, fallback: number): string => {
      const raw = n(key, fallback);
      return raw.includes('.') ? raw : `${raw}.0`;
    };
    const nOrNull = (key: string): string => {
      const v = p[key];
      return v === undefined || v === '' || v === null ? 'null' : String(Number(v));
    };
    const fieldParam = typeof p['field'] === 'string' ? p['field'] : '';
    const field = (): string => this.itemField(fieldParam, state.element, label);
    const others = (key: string): string =>
      pList(p, key)
        .map((f) => `, ${this.read(parsePathOrEmpty(f), ctx)}`)
        .join('');
    const list = (key: string, fallback: string): string => {
      const items = pList(p, key).length ? pList(p, key) : fallback.split(',');
      return `List.of(${items.map((x) => javaString(x.toLowerCase())).join(', ')})`;
    };
    switch (step.transformId) {
      case 'uppercase':
        return 'lift(v, x -> uppercase(x))';
      case 'lowercase':
        return 'lift(v, x -> lowercase(x))';
      case 'trim':
        return 'lift(v, x -> trim(x))';
      case 'capitalize':
        return `lift(v, x -> capitalize(x, ${b('allWords', true)}))`;
      case 'replace':
        return `lift(v, x -> replaceText(x, ${s('search')}, ${s('replacement')}, ${b('regex', false)}, ${b('all', true)}))`;
      case 'substring':
        return `lift(v, x -> substringOf(x, ${n('start', 0)}, ${nOrNull('end')}))`;
      case 'split':
        return `lift(v, x -> splitText(x, ${s('separator', ',')}))`;
      case 'join':
        return `joinList(v, ${s('separator', ', ')})`;
      case 'concat':
        return `liftNullable(v, x -> concatText(x, ${s('prefix')}, ${s('suffix')}, ${s('separator')}${others('fields')}))`;
      case 'removeAccents':
        return 'lift(v, x -> removeAccents(x))';
      case 'padStart':
        return `lift(v, x -> padStartText(x, ${n('length', 0)}, ${s('char', ' ')}))`;
      case 'padEnd':
        return `lift(v, x -> padEndText(x, ${n('length', 0)}, ${s('char', ' ')}))`;
      case 'stringToNumber':
        return `lift(v, x -> stringToNumber(x, ${s('decimalSeparator', '.')}))`;
      case 'numberToString':
        return `lift(v, x -> numberToText(x, ${nOrNull('digits')}))`;
      case 'round':
        return `lift(v, x -> roundTo(x, ${n('digits', 0)}))`;
      case 'floor':
        return 'lift(v, x -> floorOf(x))';
      case 'ceil':
        return 'lift(v, x -> ceilOf(x))';
      case 'abs':
        return 'lift(v, x -> absOf(x))';
      case 'multiply':
        return `lift(v, x -> multiply(x, ${dbl('operand', 0)}))`;
      case 'divide':
        return `lift(v, x -> divide(x, ${dbl('operand', 0)}))`;
      case 'add':
        return `lift(v, x -> add(x, ${dbl('operand', 0)}))`;
      case 'subtract':
        return `lift(v, x -> subtract(x, ${dbl('operand', 0)}))`;
      case 'precision':
        return `lift(v, x -> precisionOf(x, ${n('digits', 0)}))`;
      case 'stringToDate':
        return `lift(v, x -> stringToDate(x, ${s('pattern')}))`;
      case 'dateToString':
        return `lift(v, x -> dateToText(x, ${s('pattern')}))`;
      case 'toIso8601':
        return `lift(v, x -> toIso8601(x, ${s('timeZone', 'UTC')}))`;
      case 'formatDate':
        return `lift(v, x -> formatDate(x, ${s('inputPattern')}, ${s('pattern')}))`;
      case 'convertTimezone':
        return `lift(v, x -> convertTimezone(x, ${s('from', 'UTC')}, ${s('to')}))`;
      case 'datePart':
        return `lift(v, x -> datePart(x, ${s('part', 'year')}))`;
      case 'isValidDate':
        return `lift(v, x -> isValidDate(x, ${s('pattern')}))`;
      case 'stringToBoolean':
        return `lift(v, x -> stringToBoolean(x, ${list('trueValues', 'true,1,yes,y,sim,s')}, ${list('falseValues', 'false,0,no,n,nao,não')}))`;
      case 'numberToBoolean':
        return 'lift(v, x -> numberToBoolean(x))';
      case 'booleanToString':
        return `lift(v, x -> booleanToText(x, ${s('trueLabel', 'true')}, ${s('falseLabel', 'false')}))`;
      case 'defaultValue':
        return `defaultValue(v, ${javaLiteral(p['value'])}, ${b('emptyAsNull', false)})`;
      case 'coalesce':
        return `coalesce(v${others('paths')})`;
      case 'conditional':
        return `liftNullable(v, x -> conditional(x, ${s('operator', 'eq')}, ${javaLiteral(p['compare'])}, ${p['thenValue'] !== undefined}, ${javaLiteral(p['thenValue'])}, ${p['elseValue'] !== undefined}, ${javaLiteral(p['elseValue'])}))`;
      case 'constant':
        return javaLiteral(p['value']);
      case 'lookup':
        return `lift(v, x -> lookup(x, ${javaLiteral(p['table'] ?? {})}, ${javaLiteral(p['fallback'])}, ${b('keepUnmatched', false)}))`;
      case 'enumMap':
        return `lift(v, x -> enumMap(x, ${javaLiteral(p['table'] ?? {})}, ${b('strict', true)}))`;
      case 'nullHandling':
        return `nullHandling(v, ${s('mode', 'omit')})`;
      case 'removeEmpty':
        return 'removeEmpty(v)';
      case 'filter':
        return `filterList(v, ${field()}, ${s('operator', 'eq')}, ${javaLiteral(p['value'])})`;
      case 'map': {
        const code = `mapList(v, ${field()})`;
        state.element = this.fieldChild(state.element, fieldParam);
        return code;
      }
      case 'distinct':
        return `distinctList(v, ${field()})`;
      case 'sort':
        return `sortList(v, ${field()}, ${p['direction'] === 'desc'})`;
      case 'count':
        return 'countList(v)';
      case 'sum':
        return `sumList(v, ${field()})`;
      case 'average':
        return `averageList(v, ${field()})`;
      case 'min':
        return `extreme(v, ${field()}, -1)`;
      case 'max':
        return `extreme(v, ${field()}, 1)`;
      case 'first':
        return 'firstOf(v)';
      case 'last':
        return 'lastOf(v)';
      default:
        throw new UnsupportedInJava(`Transformação sem gerador Java: ${step.transformId}`);
    }
  }

  /** Converte o `Object` do pipeline no tipo do campo de destino. */
  convert(value: string, node: FieldNode | undefined): string {
    if (!node) return value;
    const type = boxed(javaType(node, this.namer, this.targetFromJava));
    return this.convertTo(value, type, node);
  }

  private converter(type: string, node: FieldNode | undefined): string {
    const y = this.fresh('y');
    return `${y} -> ${this.convertTo(y, type, node)}`;
  }

  private convertTo(value: string, type: string, node: FieldNode | undefined): string {
    const list =
      /^(?:java\.util\.)?(List|Set|Collection|Iterable|ArrayList|LinkedList|HashSet|LinkedHashSet|TreeSet|SortedSet)<(.*)>$/.exec(
        type,
      );
    if (list) {
      const inner = list[2].replace(/^\? (extends |super )?/, '');
      const child = node?.children?.[0]?.name === '[*]' ? node.children[0] : undefined;
      const isSet = /Set$/.test(list[1]);
      return `${isSet ? 'asSetOf' : 'asListOf'}(${value}, ${this.converter(inner, child)})`;
    }
    switch (type) {
      case 'String':
      case 'CharSequence':
        return `asString(${value})`;
      case 'Long':
        return `asLong(${value})`;
      case 'Integer':
        return `asInteger(${value})`;
      case 'Short':
        return `asShort(${value})`;
      case 'Byte':
        return `asByte(${value})`;
      case 'Double':
        return `asDouble(${value})`;
      case 'Float':
        return `asFloat(${value})`;
      case 'BigDecimal':
        return `asBigDecimal(${value})`;
      case 'BigInteger':
        return `asBigInteger(${value})`;
      case 'Boolean':
        return `asBoolean(${value})`;
      case 'LocalDate':
        return `asLocalDate(${value})`;
      case 'LocalDateTime':
        return `asLocalDateTime(${value})`;
      case 'OffsetDateTime':
        return `asOffsetDateTime(${value})`;
      case 'ZonedDateTime':
        return `asZonedDateTime(${value})`;
      case 'Instant':
        return `asInstant(${value})`;
      case 'UUID':
        return `asUuid(${value})`;
      case 'Object':
        return value;
      default:
        if (node?.type === 'enum' && node.typeName)
          return `asEnum(${node.typeName}.class, ${value})`;
        if (node?.type === 'object' || node?.type === 'array' || !node) {
          throw new UnsupportedInJava(
            `a conversão para ${type} exige mapear os campos individualmente.`,
          );
        }
        throw new UnsupportedInJava(`o tipo ${type} não tem conversão gerada.`);
    }
  }

  /** Elemento do valor que chega ao pipeline, para leituras por campo. */
  initialElement(path: string): FieldNode | undefined {
    const node = this.sourceFields.get(path);
    if (!node) return undefined;
    if (node.type === 'array' && hasObjectItems(node)) return node;
    return node;
  }
}

class PlainEmitter {
  readonly warnings: string[] = [];
  readonly w = new CodeWriter();

  constructor(
    private readonly ex: JavaExpressions,
    private readonly comments: boolean,
    private readonly fromJava: boolean,
  ) {}

  private leaf(
    leaf: PlanLeaf,
    ctx: JavaContext,
    write: (value: string, primitive: boolean) => string,
  ): void {
    const m = leaf.mapping;
    const w = this.w;
    const excess =
      countWildcards(leaf.sourceSegs) -
      [...ctx.bindings.keys()].filter((k) => wildcardPrefixes(m.sourcePath).includes(k)).length;
    const steps = m.transforms.filter((t) => !t.disabled);
    const conditions = m.conditions ?? [];
    const label = `${m.sourcePath || '(sem origem)'} -> ${m.targetPath}`;
    let lines: string[];
    try {
      const rowConds = excess > 0 ? [] : conditions.map((c) => this.ex.condition(c, ctx));
      const read =
        m.sourcePath === ''
          ? 'null'
          : this.ex.read(leaf.sourceSegs, ctx, excess > 0 ? conditions : undefined);
      const state = { element: this.ex.initialElement(m.sourcePath) };
      const stepLines = steps.map((s) => `v = ${this.ex.step(s, ctx, state)};`);
      const type = leaf.node ? javaType(leaf.node, this.ex.namer, this.fromJava) : 'Object';
      const converted = this.ex.convert('v', leaf.node);
      lines = [
        ...(rowConds.length ? [`if (${rowConds.join(' && ')}) {`] : ['{']),
        `  Object v = ${read};`,
        ...stepLines.map((l) => `  ${l}`),
        ...(m.defaultValue !== undefined
          ? [`  if (v == null) v = ${javaLiteral(m.defaultValue)};`]
          : []),
        `  ${write(converted, isPrimitive(type))}`,
        '}',
      ];
    } catch (e) {
      if (!(e instanceof UnsupportedInJava)) throw e;
      this.warnings.push(`Mapeamento ${label} não foi gerado em Java: ${e.message}`);
      w.line(`// NÃO GERADO: ${label}: ${e.message}`);
      return;
    }
    if (this.comments) w.line(`// ${label}`);
    w.block(lines.join('\n'));
  }

  object(plan: PlanObject, varName: string, ctx: JavaContext): void {
    for (const child of plan.children.values()) {
      const node = child.node;
      if (!node) continue;
      const setter = `${varName}.${setterName(node)}`;
      if (child.kind === 'leaf') {
        this.leaf(child, ctx, (value, primitive) =>
          primitive ? `if (v != null) ${setter}(${value});` : `${setter}(${value});`,
        );
      } else if (child.kind === 'object') {
        const name = this.ex.fresh(javaFieldName(node));
        this.w.line(`${this.ex.namer.nameOf(node)} ${name} = new ${this.ex.namer.nameOf(node)}();`);
        this.object(child, name, ctx);
        this.w.line(`${setter}(${name});`);
      } else {
        this.array(child, ctx, (out) => `${setter}(${this.fitCollection(out, node)});`);
      }
    }
  }

  private fitCollection(out: string, node: FieldNode): string {
    return /^(?:java\.util\.)?(Set|HashSet|LinkedHashSet|TreeSet|SortedSet)</.test(
      node.nativeType ?? '',
    )
      ? `new LinkedHashSet<>(${out})`
      : out;
  }

  private elementType(plan: PlanArray): string {
    const node = plan.node;
    if (node && hasObjectItems(node)) return this.ex.namer.nameOf(node);
    const item = plan.item;
    if (item && item.kind === 'array') return `List<${this.elementType(item)}>`;
    if (item && item.kind === 'leaf' && item.node)
      return boxed(javaType(item.node, this.ex.namer, this.fromJava));
    return 'Object';
  }

  array(plan: PlanArray, ctx: JavaContext, assign: (out: string) => string): void {
    const w = this.w;
    const prefix = plan.sourcePrefix as string;
    const segs = parsePathOrEmpty(prefix);
    const rows = this.ex.fresh('rows');
    const out = this.ex.fresh('out');
    const item = this.ex.fresh('item');
    const elementType = this.elementType(plan);
    const sourceNode = this.ex.sourceFields.get(prefix.replace(/\[\*\]$/, ''));
    if (this.comments) w.line(`// Cada item de ${prefix} gera uma linha.`);
    w.line(`var ${rows} = ${this.ex.read(segs.slice(0, -1), ctx)};`);
    w.open(`if (${rows} != null) {`);
    w.line(`List<${elementType}> ${out} = new ArrayList<>();`);
    let selected = rows;
    if (plan.scope) {
      const s = plan.scope;
      const filter = s.filter?.length
        ? `r -> ${s.filter.map((c) => `evaluate(${this.rowField(c.field, sourceNode)}, ${javaString(c.operator)}, ${javaLiteral(c.value)})`).join(' && ')}`
        : 'null';
      const distinct = s.distinctBy ? `r -> ${this.rowField(s.distinctBy, sourceNode)}` : 'null';
      const sort = s.sort ? `r -> ${this.rowField(s.sort.field, sourceNode)}` : 'null';
      selected = `selectRows(${rows}, ${filter}, ${distinct}, ${sort}, ${s.sort?.direction === 'desc'})`;
    }
    w.open(`for (var ${item} : ${selected}) {`);
    const inner: JavaContext = {
      root: ctx.root,
      bindings: new Map(ctx.bindings).set(prefix, { variable: item, node: sourceNode }),
    };
    const child = plan.item as PlanNode;
    if (child.kind === 'leaf') {
      let wrote = false;
      this.leaf(child, inner, (value) => {
        wrote = true;
        return `${out}.add(${value});`;
      });
      void wrote;
    } else if (child.kind === 'object') {
      const row = this.ex.fresh('row');
      w.line(`${elementType} ${row} = new ${elementType}();`);
      this.object(child, row, inner);
      w.line(`${out}.add(${row});`);
    } else {
      this.array(child, inner, (nested) => `${out}.add(${nested});`);
    }
    w.close();
    w.line(assign(out));
    w.close();
  }

  private rowField(field: string, element: FieldNode | undefined): string {
    let expr = 'Optional.ofNullable(r)';
    let node = element;
    for (const seg of parsePathOrEmpty(field)) {
      if (seg.kind !== 'prop')
        throw new UnsupportedInJava(`caminho "${field}" com lista em um escopo.`);
      node = node?.children?.find((c) => c.name === seg.name);
      const getter = node ? getterName(node) : `get${pascalCase(seg.name)}`;
      const y = this.ex.fresh('y');
      expr = `${expr}.map(${y} -> ${y}.${getter}())`;
    }
    return `${expr}.orElse(null)`;
  }
}

function header(pkg: string, body: string, extraImports: string[] = []): string {
  const imports = [...new Set([...importsFor(body), ...extraImports])].sort();
  return `${pkg ? `package ${pkg};\n\n` : ''}${imports.length ? `${imports.join('\n')}\n\n` : ''}${body}`;
}

function dtoClass(node: FieldNode, name: string, namer: TypeNamer, comments: boolean): string {
  const w = new CodeWriter('    ');
  if (comments)
    w.line(`/** DTO gerado pelo MapForge${node.path ? ` para \`${node.path}\`` : ''}. */`);
  w.open(`public class ${name} {`);
  const fields = (node.children ?? []).filter((c) => c.name !== '[*]');
  for (const f of fields) {
    const field = javaFieldName(f);
    if (field !== f.name) w.line(`@JsonProperty(${javaString(f.name)})`);
    w.line(`private ${javaType(f, namer, false)} ${field};`);
  }
  for (const f of fields) {
    const field = javaFieldName(f);
    const type = javaType(f, namer, false);
    w.line();
    w.open(`public ${type} ${getterName(f)}() {`);
    w.line(`return ${field};`);
    w.close();
    w.line();
    w.open(`public void ${setterName(f)}(${type} ${field}) {`);
    w.line(`this.${field} = ${field};`);
    w.close();
  }
  w.close();
  return w.toString();
}

function enumNames(root: FieldNode | null): FieldNode[] {
  if (!root) return [];
  const out: FieldNode[] = [];
  const visit = (n: FieldNode): void => {
    if (n.type === 'enum' && n.typeName) out.push(n);
    n.children?.forEach(visit);
  };
  visit(root);
  return out;
}

/** Classes dos lados que não vieram de Java (quem veio de Java já tem as próprias). */
export function dtoFiles(
  plan: MappingPlan,
  doc: ProjectDocument,
  settings: CodegenSettings,
  namer: TypeNamer,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  const emit = (root: FieldNode | null, skip: boolean): void => {
    if (skip || !root) return;
    for (const node of namer.declarations(root)) {
      const name = namer.nameOf(node);
      if (seen.has(name)) continue;
      seen.add(name);
      if (node.path === '' && node.type === 'array' && !hasObjectItems(node)) continue;
      files.push({
        name: javaClassFileName(name),
        language: 'java',
        content: header(settings.javaPackage, dtoClass(node, name, namer, settings.comments)),
      });
    }
    for (const node of enumNames(root)) {
      const name = node.typeName as string;
      if (seen.has(name)) continue;
      seen.add(name);
      files.push({
        name: javaClassFileName(name),
        language: 'java',
        content: header(
          settings.javaPackage,
          `public enum ${name} {\n    ${(node.enumValues ?? []).join(', ')}\n}\n`,
        ),
      });
    }
  };
  emit(plan.source.root, doc.source.format === 'java');
  emit(plan.target.root, doc.target.format === 'java');
  return files;
}

function rootWarnings(doc: ProjectDocument): string[] {
  const out: string[] = [];
  for (const side of [doc.source, doc.target]) {
    if (side.format === 'java') {
      if (/\brecord\s+\w+\s*[(<]/.test(side.text)) {
        out.push(
          `${side.rootName}: o código gerado usa getters e setters de JavaBean; records exigem ajuste manual.`,
        );
      }
    }
  }
  return out;
}

function rootClass(root: FieldNode | null, namer: TypeNamer, fallback: string): string {
  return root ? namer.nameOf(root) : fallback;
}

export function generateJavaPlain(
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
  const ex = new JavaExpressions(
    plan,
    namer,
    doc.source.format === 'java',
    doc.target.format === 'java',
  );
  const emitter = new PlainEmitter(ex, settings.comments, doc.target.format === 'java');
  const className = pascalCase(settings.mapperName) || 'DataMapper';
  const w = emitter.w;
  const sourceClass = rootClass(plan.source.root, namer, 'Object');
  const targetClass = rootClass(plan.target.root, namer, 'Object');
  const warnings = [...plan.warnings, ...rootWarnings(doc)];

  if (settings.comments) {
    w.line('/**');
    w.line(` * Converte ${plan.source.rootName} em ${plan.target.rootName}. Gerado pelo MapForge.`);
    w.line(' * Leituras são seguras contra null e valores inválidos resultam em null.');
    w.line(' */');
  }
  w.open(`public final class ${className} {`);
  w.line();
  const ctx: JavaContext = { root: 'source', bindings: new Map() };
  if (plan.root.kind === 'object') {
    w.open(`public ${targetClass} map(${sourceClass} source) {`);
    w.line('if (source == null) return null;');
    w.line(`${targetClass} target = new ${targetClass}();`);
    emitter.object(plan.root, 'target', ctx);
    w.line('return target;');
    w.close();
  } else {
    warnings.push('Estruturas com array na raiz não são geradas em Java: use um objeto como raiz.');
    w.line('// Estruturas com array na raiz não são geradas em Java.');
  }
  const body = w.toString();
  const helpers = runtime.select(body);
  for (const h of helpers) {
    w.line();
    w.block(h);
  }
  w.close();
  const content = header(settings.javaPackage, w.toString());
  return {
    files: [
      { name: javaClassFileName(className), language: 'java', content },
      ...dtoFiles(plan, doc, settings, namer),
    ],
    warnings: [...warnings, ...emitter.warnings],
  };
}

export function generateJavaDtos(doc: ProjectDocument, settings: CodegenSettings): GeneratedOutput {
  const plan = buildPlan(doc);
  const namer = new TypeNamer(
    plan.source.root,
    plan.target.root,
    plan.source.rootName,
    plan.target.rootName,
  );
  const files = dtoFiles(
    plan,
    {
      ...doc,
      source: { ...doc.source, format: 'json' },
      target: { ...doc.target, format: 'json' },
    },
    settings,
    namer,
  );
  return { files, warnings: [] };
}

export { runtime as javaRuntime, header as javaHeader, rootClass, rootWarnings };
