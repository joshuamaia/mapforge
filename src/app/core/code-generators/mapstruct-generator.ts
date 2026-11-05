import { CodegenSettings, ProjectDocument } from '../models/project.model';
import { FieldNode } from '../models/schema.model';
import { countWildcards, formatPath, parsePathOrEmpty } from '../mapping-engine/path';
import { boxed, javaClassFileName, javaString, javaType } from './java-model';
import {
  dtoFiles,
  JavaContext,
  JavaExpressions,
  javaHeader,
  javaLiteral,
  javaRuntime,
  rootClass,
  rootWarnings,
  UnsupportedInJava,
} from './java-generator';
import {
  buildPlan,
  camelCase,
  hasObjectItems,
  MappingPlan,
  pascalCase,
  PlanArray,
  PlanLeaf,
  PlanNode,
  PlanObject,
  TypeNamer,
} from './plan';
import { GeneratedFile, GeneratedOutput } from './types';
import { CodeWriter } from './writer';

const NUMERIC = new Set([
  'byte',
  'short',
  'int',
  'long',
  'float',
  'double',
  'Byte',
  'Short',
  'Integer',
  'Long',
  'Float',
  'Double',
  'BigDecimal',
  'BigInteger',
]);

/** Pares de tipo que o próprio MapStruct converte sem método auxiliar. */
function isDirect(from: string, to: string): boolean {
  if (from === to) return true;
  if (to === 'String' && (NUMERIC.has(from) || from === 'Boolean' || from === 'boolean'))
    return true;
  return NUMERIC.has(from) && NUMERIC.has(to);
}

interface ElementMethod {
  name: string;
  sourceClass: string;
  targetClass: string;
  mappings: string[];
  sourceNode?: FieldNode;
}

class MapStructEmitter {
  readonly warnings: string[] = [];
  readonly methods: ElementMethod[] = [];
  readonly helpers: string[] = [];
  private readonly usedNames = new Set<string>();

  constructor(
    private readonly ex: JavaExpressions,
    private readonly fromJavaSource: boolean,
    private readonly fromJavaTarget: boolean,
    private readonly comments: boolean,
  ) {}

  private unique(base: string): string {
    let name = base;
    let i = 2;
    while (this.usedNames.has(name)) name = `${base}${i++}`;
    this.usedNames.add(name);
    return name;
  }

  private sourceType(node: FieldNode | undefined): string {
    return node ? javaType(node, this.ex.namer, this.fromJavaSource) : 'Object';
  }

  private targetType(node: FieldNode | undefined): string {
    return node ? javaType(node, this.ex.namer, this.fromJavaTarget) : 'Object';
  }

  /** Caminho do MapStruct, relativo ao objeto corrente. */
  private relativeTarget(path: string, prefix: string): string {
    const relative = prefix
      ? parsePathOrEmpty(path).slice(parsePathOrEmpty(prefix).length)
      : parsePathOrEmpty(path);
    return relative
      .map((s) => (s.kind === 'prop' ? s.name : ''))
      .filter((x) => x !== '')
      .join('.');
  }

  /** Adiciona uma linha @Mapping para um valor simples de um objeto. */
  private leafMapping(
    leaf: PlanLeaf,
    sourcePrefix: string,
    targetPrefix: string,
    ownerClass: string,
    mappings: string[],
  ): void {
    const m = leaf.mapping;
    const target = this.relativeTarget(m.targetPath, targetPrefix);
    const label = `${m.sourcePath || '(sem origem)'} -> ${m.targetPath}`;
    const steps = m.transforms.filter((t) => !t.disabled);
    const srcSegs = parsePathOrEmpty(m.sourcePath);
    const excess = countWildcards(srcSegs) - countWildcards(parsePathOrEmpty(sourcePrefix));
    const isConstant =
      m.sourcePath === '' &&
      steps.length === 1 &&
      steps[0].transformId === 'constant' &&
      ['string', 'number', 'boolean'].includes(typeof steps[0].params['value']);
    if (isConstant) {
      // O MapStruct exige o sufixo L em constantes de campos long.
      const isLong = /^(long|Long)$/.test(this.targetType(leaf.node));
      const text = `${String(steps[0].params['value'])}${isLong ? 'L' : ''}`;
      mappings.push(`@Mapping(target = ${javaString(target)}, constant = ${javaString(text)})`);
      return;
    }
    const sourceNode = this.ex.sourceFields.get(m.sourcePath);
    const conditions = m.conditions ?? [];
    const relativeSource = srcSegs.slice(parsePathOrEmpty(sourcePrefix).length);
    const simple =
      m.sourcePath !== '' &&
      excess === 0 &&
      conditions.length === 0 &&
      relativeSource.every((s) => s.kind === 'prop') &&
      !steps.some((s) => s.params['fields'] || s.params['paths']);

    if (simple && steps.length === 0 && m.defaultValue === undefined) {
      const from = this.sourceType(sourceNode);
      const to = this.targetType(leaf.node);
      if (isDirect(from, to) || (sourceNode?.type === 'object' && leaf.node?.type === 'object')) {
        mappings.push(
          `@Mapping(target = ${javaString(target)}, source = ${javaString(this.relativeSource(relativeSource))})`,
        );
        return;
      }
    }
    try {
      const name = this.unique(`${camelCase(`to ${target.replace(/\./g, ' ')}`)}`);
      const convert = this.ex.convert('v', leaf.node);
      const returnType = boxed(this.targetType(leaf.node));
      const lines: string[] = [];
      let param: string;
      let sourceAttr: string;
      const ctx: JavaContext = { root: 'value', bindings: new Map() };
      if (simple) {
        param = `${boxed(this.sourceType(sourceNode))} value`;
        sourceAttr = this.relativeSource(relativeSource);
        lines.push('Object v = value;');
      } else {
        // Precisa de outros campos da linha: recebe o objeto inteiro.
        param = `${ownerClass} value`;
        sourceAttr = '.';
        if (sourcePrefix)
          ctx.bindings.set(sourcePrefix, {
            variable: 'value',
            node: this.ex.sourceFields.get(sourcePrefix.replace(/\[\*\]$/, '')),
          });
        for (const c of excess === 0 ? conditions : []) {
          lines.push(`if (!${this.ex.condition(c, ctx)}) return null;`);
        }
        const read =
          m.sourcePath === ''
            ? 'null'
            : this.ex.read(srcSegs, ctx, excess > 0 ? conditions : undefined);
        lines.push(`Object v = ${read};`);
      }
      const state = { element: this.ex.initialElement(m.sourcePath) };
      for (const step of steps) lines.push(`v = ${this.ex.step(step, ctx, state)};`);
      if (m.defaultValue !== undefined)
        lines.push(`if (v == null) v = ${javaLiteral(m.defaultValue)};`);
      lines.push(`return ${convert};`);
      mappings.push(
        `@Mapping(target = ${javaString(target)}, source = ${javaString(sourceAttr)}, qualifiedByName = ${javaString(name)})`,
      );
      const h = new CodeWriter();
      if (this.comments) h.line(`/** ${label} */`);
      h.line(`@Named(${javaString(name)})`);
      h.open(`default ${returnType} ${name}(${param}) {`);
      for (const l of lines) h.line(l);
      h.close();
      this.helpers.push(h.toString().trimEnd());
    } catch (e) {
      if (!(e instanceof UnsupportedInJava)) throw e;
      this.warnings.push(`Mapeamento ${label} não é representável no MapStruct: ${e.message}`);
      mappings.push(`// NÃO REPRESENTÁVEL: ${label}: ${e.message}`);
      mappings.push(`@Mapping(target = ${javaString(target)}, ignore = true)`);
    }
  }

  private relativeSource(segs: ReturnType<typeof parsePathOrEmpty>): string {
    return segs.map((s) => (s.kind === 'prop' ? s.name : '')).join('.');
  }

  /** Percorre um objeto do plano, gerando as linhas @Mapping do método corrente. */
  object(
    plan: PlanObject,
    sourcePrefix: string,
    targetPrefix: string,
    ownerClass: string,
    mappings: string[],
  ): void {
    for (const child of plan.children.values()) {
      if (child.kind === 'leaf') {
        this.handleLeaf(child, sourcePrefix, targetPrefix, ownerClass, mappings);
      } else if (child.kind === 'object') {
        this.object(child, sourcePrefix, targetPrefix, ownerClass, mappings);
      } else {
        this.array(child, sourcePrefix, targetPrefix, mappings);
      }
    }
  }

  private handleLeaf(
    leaf: PlanLeaf,
    sourcePrefix: string,
    targetPrefix: string,
    ownerClass: string,
    mappings: string[],
  ): void {
    const m = leaf.mapping;
    const s = countWildcards(parsePathOrEmpty(m.sourcePath));
    const t = countWildcards(parsePathOrEmpty(m.targetPath));
    if (t > s) {
      const message =
        'copiar um valor do contexto pai para as linhas de um array não tem equivalente em @Mapping.';
      const label = `${m.sourcePath || '(sem origem)'} -> ${m.targetPath}`;
      this.warnings.push(`Mapeamento ${label} não é representável no MapStruct: ${message}`);
      mappings.push(`// NÃO REPRESENTÁVEL: ${label}: ${message}`);
      mappings.push(
        `@Mapping(target = ${javaString(this.relativeTarget(m.targetPath, targetPrefix))}, ignore = true)`,
      );
      return;
    }
    this.leafMapping(leaf, sourcePrefix, targetPrefix, ownerClass, mappings);
  }

  /** Cada par de arrays gera um método por item; o MapStruct cria a iteração sozinho. */
  private array(
    plan: PlanArray,
    sourcePrefix: string,
    targetPrefix: string,
    mappings: string[],
  ): void {
    const prefix = plan.sourcePrefix as string;
    const node = plan.node;
    const targetArrayPath = node?.path ?? '';
    const target = this.relativeTarget(targetArrayPath, targetPrefix);
    const srcSegs = parsePathOrEmpty(prefix).slice(0, -1);
    const relative = srcSegs.slice(parsePathOrEmpty(sourcePrefix).length);
    const sourceAttr = this.relativeSource(relative);
    const sourceArray = this.ex.sourceFields.get(formatPath(srcSegs));
    const item = plan.item as PlanNode;

    if (item.kind === 'object' && node && sourceArray && hasObjectItems(sourceArray)) {
      const sourceClass = this.ex.namer.nameOf(sourceArray);
      const targetClass = this.ex.namer.nameOf(node);
      const name = this.unique(camelCase(`to ${targetClass}`));
      const method: ElementMethod = {
        name,
        sourceClass,
        targetClass,
        mappings: [],
        sourceNode: sourceArray,
      };
      this.methods.push(method);
      this.object(item, prefix, `${targetArrayPath}[*]`, sourceClass, method.mappings);
      if (plan.scope) {
        this.scopedList(
          plan,
          target,
          sourceAttr,
          sourceClass,
          targetClass,
          name,
          mappings,
          sourceArray,
        );
      } else {
        mappings.push(
          `@Mapping(target = ${javaString(target)}, source = ${javaString(sourceAttr)})`,
        );
      }
      return;
    }
    if (item.kind === 'leaf' && !plan.scope && item.mapping.transforms.every((t) => t.disabled)) {
      const from = sourceArray?.children?.[0];
      if (from && item.node && isDirect(this.sourceType(from), this.targetType(item.node))) {
        mappings.push(
          `@Mapping(target = ${javaString(target)}, source = ${javaString(sourceAttr)})`,
        );
        return;
      }
    }
    const label = `${prefix} -> ${targetArrayPath}`;
    const message = 'lista de valores com transformação ou arrays de arrays exigem o Java puro.';
    this.warnings.push(`Mapeamento ${label} não é representável no MapStruct: ${message}`);
    mappings.push(`// NÃO REPRESENTÁVEL: ${label}: ${message}`);
    mappings.push(`@Mapping(target = ${javaString(target)}, ignore = true)`);
  }

  /** Filtro, distinct e sort viram um método default que seleciona as linhas. */
  private scopedList(
    plan: PlanArray,
    target: string,
    sourceAttr: string,
    sourceClass: string,
    targetClass: string,
    elementMethod: string,
    mappings: string[],
    sourceArray: FieldNode,
  ): void {
    const s = plan.scope;
    if (!s) return;
    const name = this.unique(camelCase(`select ${target.replace(/\./g, ' ')}`));
    const field = (path: string): string =>
      this.ex
        .itemField(path, sourceArray, 'Escopo')
        .replace(/^x -> /, '')
        .replace(/\(\w+\) x\b/, 'r');
    const filter = s.filter?.length
      ? `r -> ${s.filter.map((c) => `evaluate(${field(c.field)}, ${javaString(c.operator)}, ${javaLiteral(c.value)})`).join(' && ')}`
      : 'null';
    const distinct = s.distinctBy ? `r -> ${field(s.distinctBy)}` : 'null';
    const sort = s.sort ? `r -> ${field(s.sort.field)}` : 'null';
    const h = new CodeWriter();
    if (this.comments)
      h.line(`/** Aplica o escopo de ${s.sourcePath}: filtro, distinct e ordenação. */`);
    h.line(`@Named(${javaString(name)})`);
    h.open(`default List<${targetClass}> ${name}(List<${sourceClass}> rows) {`);
    h.line('if (rows == null) return null;');
    h.line(`List<${targetClass}> out = new ArrayList<>();`);
    h.line(
      `for (${sourceClass} row : selectRows(rows, ${filter}, ${distinct}, ${sort}, ${s.sort?.direction === 'desc'})) out.add(${elementMethod}(row));`,
    );
    h.line('return out;');
    h.close();
    this.helpers.push(h.toString().trimEnd());
    mappings.push(
      `@Mapping(target = ${javaString(target)}, source = ${javaString(sourceAttr)}, qualifiedByName = ${javaString(name)})`,
    );
  }
}

export function generateMapStruct(
  doc: ProjectDocument,
  settings: CodegenSettings,
): GeneratedOutput {
  const plan: MappingPlan = buildPlan(doc);
  const namer = new TypeNamer(
    plan.source.root,
    plan.target.root,
    plan.source.rootName,
    plan.target.rootName,
  );
  const fromJavaSource = doc.source.format === 'java';
  const fromJavaTarget = doc.target.format === 'java';
  const ex = new JavaExpressions(plan, namer, fromJavaSource, fromJavaTarget);
  const emitter = new MapStructEmitter(ex, fromJavaSource, fromJavaTarget, settings.comments);
  const className = pascalCase(settings.mapperName) || 'DataMapper';
  const warnings = [...plan.warnings, ...rootWarnings(doc)];
  const w = new CodeWriter('    ');
  const sourceClass = rootClass(plan.source.root, namer, 'Object');
  const targetClass = rootClass(plan.target.root, namer, 'Object');

  if (settings.comments) {
    w.line('/**');
    w.line(
      ` * Mapper MapStruct de ${plan.source.rootName} para ${plan.target.rootName}. Gerado pelo MapForge.`,
    );
    w.line(' * Em Spring Boot, adicione componentModel = "spring" à anotação @Mapper.');
    w.line(' */');
  }
  w.line('@Mapper(unmappedTargetPolicy = ReportingPolicy.IGNORE)');
  w.open(`public interface ${className} {`);
  w.line();
  const mappings: string[] = [];
  if (plan.root.kind === 'object') {
    emitter.object(plan.root, '', '', sourceClass, mappings);
    for (const m of mappings) w.line(m);
    w.line(`${targetClass} map(${sourceClass} source);`);
  } else {
    warnings.push(
      'Estruturas com array na raiz não são geradas no MapStruct: use um objeto como raiz.',
    );
    w.line('// Estruturas com array na raiz não são geradas no MapStruct.');
  }
  for (const method of emitter.methods) {
    w.line();
    for (const m of method.mappings) w.line(m);
    w.line(`${method.targetClass} ${method.name}(${method.sourceClass} source);`);
  }
  for (const helper of emitter.helpers) {
    w.line();
    w.block(helper);
  }
  w.close();
  const code = w.toString();
  // Interfaces não aceitam campos e classes privados: o runtime fica em uma classe vizinha.
  const pkg = settings.javaPackage || 'com.example.mapping';
  const runtimeName = `${className}Runtime`;
  const runtimeSections = javaRuntime.select(code);
  const runtimeFile: GeneratedFile[] = [];
  const staticImport: string[] = [];
  if (runtimeSections.length > 0) {
    const r = new CodeWriter('    ');
    if (settings.comments)
      r.line(`/** Funções auxiliares usadas por ${className}. Geradas pelo MapForge. */`);
    r.open(`final class ${runtimeName} {`);
    r.line();
    r.line(`private ${runtimeName}() {}`);
    for (const section of runtimeSections) {
      r.line();
      r.block(section.replace(/^(\s*)private static /gm, '$1static '));
    }
    r.close();
    runtimeFile.push({
      name: javaClassFileName(runtimeName),
      language: 'java',
      content: javaHeader(pkg, r.toString()),
    });
    staticImport.push(`import static ${pkg}.${runtimeName}.*;`);
  }
  return {
    files: [
      {
        name: javaClassFileName(className),
        language: 'java',
        content: javaHeader(pkg, code, staticImport),
      },
      ...runtimeFile,
      ...dtoFiles(plan, doc, { ...settings, javaPackage: pkg }, namer),
    ],
    warnings: [...warnings, ...emitter.warnings],
  };
}
