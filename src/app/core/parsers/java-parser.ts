import { FieldNode, FieldType, ParseIssue, ParseResult } from '../models/schema.model';
import { childPath } from '../mapping-engine/path';
import { SourceSyntaxError, Token, tokenize, TokenStream } from './tokenizer';

/**
 * Parser recursive descent de um subconjunto de Java voltado a DTOs. Reconhece a estrutura de
 * declarações (classes, records, enums, herança, classes aninhadas, genéricos, anotações) e
 * ignora corpos de métodos e inicializadores balanceando chaves. Não valida semântica Java.
 */

interface JavaType {
  name: string;
  args: JavaType[];
  dims: number;
  text: string;
}

interface JavaField {
  name: string;
  type: JavaType;
  annotations: JavaAnnotation[];
  isStatic: boolean;
  isTransient: boolean;
  line: number;
}

interface JavaAnnotation {
  name: string;
  value?: string;
}

interface JavaClass {
  kind: 'class' | 'record' | 'enum' | 'interface';
  name: string;
  qualifiedName: string;
  typeParams: string[];
  superClass?: string;
  fields: JavaField[];
  enumConstants: string[];
  line: number;
}

const MODIFIERS = new Set([
  'public',
  'protected',
  'private',
  'static',
  'final',
  'abstract',
  'transient',
  'volatile',
  'synchronized',
  'native',
  'strictfp',
  'default',
  'sealed',
  'non',
]);
const REQUIRED_ANNOTATIONS = new Set(['NotNull', 'NotBlank', 'NotEmpty', 'Nonnull', 'NonNull']);
const RELEVANT_ANNOTATIONS = new Set([
  ...REQUIRED_ANNOTATIONS,
  'JsonProperty',
  'Size',
  'Min',
  'Max',
  'Email',
  'Pattern',
  'Past',
  'Future',
  'JsonFormat',
  'Valid',
  'Positive',
  'PositiveOrZero',
  'DecimalMin',
  'DecimalMax',
]);

const SCALARS: Record<string, FieldType> = {
  byte: 'integer',
  short: 'integer',
  int: 'integer',
  long: 'integer',
  Byte: 'integer',
  Short: 'integer',
  Integer: 'integer',
  Long: 'integer',
  BigInteger: 'integer',
  float: 'number',
  double: 'number',
  Float: 'number',
  Double: 'number',
  BigDecimal: 'number',
  Number: 'number',
  boolean: 'boolean',
  Boolean: 'boolean',
  char: 'string',
  Character: 'string',
  String: 'string',
  CharSequence: 'string',
  UUID: 'string',
  LocalDate: 'date',
  LocalDateTime: 'datetime',
  OffsetDateTime: 'datetime',
  ZonedDateTime: 'datetime',
  Instant: 'datetime',
  Date: 'datetime',
  Timestamp: 'datetime',
  Object: 'any',
  JsonNode: 'any',
};
const PRIMITIVES = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'boolean', 'char']);
const COLLECTIONS = new Set([
  'List',
  'Set',
  'Collection',
  'Iterable',
  'ArrayList',
  'LinkedList',
  'HashSet',
  'LinkedHashSet',
  'TreeSet',
  'SortedSet',
]);
const MAPS = new Set([
  'Map',
  'HashMap',
  'LinkedHashMap',
  'TreeMap',
  'SortedMap',
  'ConcurrentHashMap',
]);

class JavaParser {
  readonly classes: JavaClass[] = [];
  readonly issues: ParseIssue[] = [];
  packageName?: string;
  private readonly s: TokenStream;

  constructor(text: string) {
    this.s = new TokenStream(tokenize(text));
  }

  parse(): void {
    const s = this.s;
    this.skipAnnotations();
    if (s.accept('package')) {
      this.packageName = this.qualifiedIdent();
      s.expect(';');
    }
    while (s.is('import')) {
      s.skipUntil(';');
      s.expect(';');
    }
    while (!s.atEnd) {
      if (s.accept(';')) continue;
      this.parseTypeDecl(undefined);
    }
  }

  private qualifiedIdent(): string {
    let name = this.s.expectIdent('um identificador').text;
    while (this.s.is('.') && this.s.peek().kind === 'ident') {
      this.s.next();
      name += `.${this.s.next().text}`;
    }
    return name;
  }

  private parseAnnotation(): JavaAnnotation | null {
    const s = this.s;
    s.expect('@');
    if (s.is('interface')) return null;
    const name = this.qualifiedIdent().split('.').pop() as string;
    const annotation: JavaAnnotation = { name };
    if (s.is('(')) {
      const open = s.peek();
      if (open.kind === 'string') annotation.value = open.text;
      else if (open.text === 'value' && s.peek(2).text === '=' && s.peek(3).kind === 'string') {
        annotation.value = s.peek(3).text;
      }
      s.skipBalanced('(', ')');
    }
    return annotation;
  }

  private skipAnnotations(): JavaAnnotation[] {
    const list: JavaAnnotation[] = [];
    while (this.s.is('@') && this.s.peek().text !== 'interface') {
      const a = this.parseAnnotation();
      if (a) list.push(a);
    }
    return list;
  }

  private parseModifiers(): { annotations: JavaAnnotation[]; modifiers: Set<string> } {
    const annotations: JavaAnnotation[] = [];
    const modifiers = new Set<string>();
    for (;;) {
      if (this.s.is('@') && this.s.peek().text !== 'interface') {
        const a = this.parseAnnotation();
        if (a) annotations.push(a);
      } else if (this.s.current.kind === 'ident' && MODIFIERS.has(this.s.current.text)) {
        const text = this.s.next().text;
        modifiers.add(text);
        if (text === 'non' && this.s.accept('-')) this.s.next(); // non-sealed
      } else {
        return { annotations, modifiers };
      }
    }
  }

  private isTypeKeyword(): boolean {
    const t = this.s.current;
    if (t.kind !== 'ident') return this.s.is('@') && this.s.peek().text === 'interface';
    if (t.text === 'class' || t.text === 'interface' || t.text === 'enum') return true;
    return (
      t.text === 'record' &&
      this.s.peek().kind === 'ident' &&
      (this.s.peek(2).text === '(' || this.s.peek(2).text === '<')
    );
  }

  private parseTypeDecl(outer: string | undefined): void {
    this.parseModifiers();
    if (!this.isTypeKeyword()) {
      this.s.fail(
        `Esperada declaração de classe, record ou enum, encontrado "${this.s.describe()}".`,
      );
    }
    this.parseTypeBody(outer);
  }

  private parseTypeBody(outer: string | undefined): void {
    const s = this.s;
    if (s.accept('@')) {
      const start = s.current;
      s.expect('interface');
      s.expectIdent('o nome da anotação');
      s.skipBalanced('{', '}');
      this.issues.push({
        severity: 'info',
        kind: 'unsupported',
        line: start.line,
        message: 'Declaração @interface ignorada: anotações não são DTOs.',
      });
      return;
    }
    const keyword = s.next().text as JavaClass['kind'];
    const nameToken = s.expectIdent('o nome do tipo');
    const qualifiedName = outer ? `${outer}.${nameToken.text}` : nameToken.text;
    const cls: JavaClass = {
      kind: keyword,
      name: nameToken.text,
      qualifiedName,
      typeParams: [],
      fields: [],
      enumConstants: [],
      line: nameToken.line,
    };
    if (s.is('<')) cls.typeParams = this.parseTypeParams();
    if (keyword === 'record') {
      this.parseRecordComponents(cls);
    }
    if (s.accept('extends')) {
      const parent = this.parseType();
      if (keyword === 'class') cls.superClass = parent.name;
      while (s.accept(',')) this.parseType();
    }
    if (s.accept('implements') || s.accept('permits')) {
      this.parseType();
      while (s.accept(',')) this.parseType();
    }
    this.classes.push(cls);
    if (keyword === 'interface') {
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        line: nameToken.line,
        message: `A interface Java "${nameToken.text}" não declara campos e foi ignorada.`,
      });
      s.skipBalanced('{', '}');
      return;
    }
    s.expect('{');
    if (keyword === 'enum') this.parseEnumConstants(cls);
    this.parseMembers(cls);
    s.expect('}');
  }

  private parseTypeParams(): string[] {
    const s = this.s;
    const names: string[] = [];
    s.expect('<');
    let depth = 1;
    let expectName = true;
    while (depth > 0) {
      if (s.atEnd) s.fail('Parâmetros de tipo não terminados.');
      if (s.is('<')) depth++;
      else if (s.is('>')) depth--;
      else if (depth === 1 && s.is(',')) expectName = true;
      else if (depth === 1 && expectName && s.current.kind === 'ident') {
        names.push(s.current.text);
        expectName = false;
      }
      s.next();
    }
    return names;
  }

  private parseRecordComponents(cls: JavaClass): void {
    const s = this.s;
    s.expect('(');
    while (!s.is(')')) {
      const annotations = this.skipAnnotations();
      const type = this.parseType();
      if (s.accept('...')) type.dims++;
      const name = s.expectIdent('o nome do componente');
      cls.fields.push({
        name: name.text,
        type,
        annotations,
        isStatic: false,
        isTransient: false,
        line: name.line,
      });
      if (!s.accept(',')) break;
    }
    s.expect(')');
  }

  private parseEnumConstants(cls: JavaClass): void {
    const s = this.s;
    while (!s.is(';') && !s.is('}')) {
      this.skipAnnotations();
      cls.enumConstants.push(s.expectIdent('uma constante de enum').text);
      if (s.is('(')) s.skipBalanced('(', ')');
      if (s.is('{')) s.skipBalanced('{', '}');
      if (!s.accept(',')) break;
    }
    s.accept(';');
  }

  private parseMembers(cls: JavaClass): void {
    const s = this.s;
    while (!s.is('}')) {
      if (s.atEnd) s.fail(`Fim do arquivo dentro de "${cls.name}": falta "}".`);
      if (s.accept(';')) continue;
      const { annotations, modifiers } = this.parseModifiers();
      if (s.is('{')) {
        s.skipBalanced('{', '}');
        continue;
      }
      if (this.isTypeKeyword()) {
        this.parseTypeBody(cls.qualifiedName);
        continue;
      }
      if (s.is('<')) this.parseTypeParams();
      // Construtor: Nome(...)
      if (s.current.kind === 'ident' && s.peek().text === '(') {
        s.next();
        this.skipCallable();
        continue;
      }
      // Construtor compacto de record: Nome { ... }
      if (cls.kind === 'record' && s.current.text === cls.name && s.peek().text === '{') {
        s.next();
        s.skipBalanced('{', '}');
        continue;
      }
      const type = this.parseType();
      const nameToken = s.expectIdent('o nome do membro');
      if (s.is('(')) {
        this.skipCallable();
        continue;
      }
      this.parseFieldDeclarators(cls, type, nameToken, annotations, modifiers);
    }
  }

  private skipCallable(): void {
    const s = this.s;
    s.skipBalanced('(', ')');
    while (s.accept('[')) s.expect(']');
    if (s.accept('throws')) s.skipUntil('{', ';');
    if (s.accept('default')) s.skipUntil(';');
    if (s.is('{')) s.skipBalanced('{', '}');
    else s.expect(';');
  }

  private parseFieldDeclarators(
    cls: JavaClass,
    type: JavaType,
    first: Token,
    annotations: JavaAnnotation[],
    modifiers: Set<string>,
  ): void {
    const s = this.s;
    let nameToken = first;
    for (;;) {
      let dims = type.dims;
      while (s.accept('[')) {
        s.expect(']');
        dims++;
      }
      cls.fields.push({
        name: nameToken.text,
        type: { ...type, dims },
        annotations,
        isStatic: modifiers.has('static'),
        isTransient: modifiers.has('transient'),
        line: nameToken.line,
      });
      if (s.accept('=')) this.skipInitializer();
      if (s.accept(',')) {
        nameToken = s.expectIdent('o nome do campo');
        continue;
      }
      s.expect(';');
      return;
    }
  }

  private skipInitializer(): void {
    const s = this.s;
    let angle = 0;
    let depth = 0;
    while (!s.atEnd) {
      if (depth === 0 && angle <= 0 && (s.is(';') || s.is(','))) return;
      if (s.is('(') || s.is('{') || s.is('[')) depth++;
      else if (s.is(')') || s.is('}') || s.is(']')) depth--;
      else if (s.is('<')) angle++;
      else if (s.is('>')) angle--;
      else if (s.is(';')) return;
      s.next();
    }
  }

  private parseType(): JavaType {
    const s = this.s;
    this.skipAnnotations();
    if (s.accept('?')) {
      if (s.accept('extends') || s.accept('super')) {
        const bound = this.parseType();
        return { ...bound, text: `? ${bound.text}` };
      }
      return { name: 'Object', args: [], dims: 0, text: '?' };
    }
    const first = s.expectIdent('um tipo').text;
    let name = first;
    let text = first;
    while (s.is('.') && s.peek().kind === 'ident') {
      s.next();
      name = s.next().text;
      text += `.${name}`;
    }
    const args: JavaType[] = [];
    if (s.accept('<')) {
      if (!s.is('>')) {
        args.push(this.parseType());
        while (s.accept(',')) args.push(this.parseType());
      }
      s.expect('>');
      text += `<${args.map((a) => a.text).join(', ')}>`;
    }
    let dims = 0;
    while (s.is('[') && s.peek().text === ']') {
      s.next();
      s.next();
      dims++;
      text += '[]';
    }
    return { name, args, dims, text };
  }
}

/** Monta a árvore de campos a partir das classes declaradas. */
class SchemaBuilder {
  private readonly byName = new Map<string, JavaClass>();
  private readonly stack: string[] = [];

  constructor(
    classes: JavaClass[],
    private readonly issues: ParseIssue[],
  ) {
    for (const c of classes) this.byName.set(c.name, c);
  }

  buildRoot(cls: JavaClass): FieldNode {
    this.stack.push(cls.name);
    const children = this.fieldsOf(cls, '');
    this.stack.pop();
    return {
      name: cls.name,
      path: '',
      type: 'object',
      required: false,
      typeName: cls.qualifiedName,
      nativeType: cls.qualifiedName,
      children,
    };
  }

  private fieldsOf(cls: JavaClass, parentPath: string): FieldNode[] {
    const nodes: FieldNode[] = [];
    if (cls.superClass) {
      const parent = this.byName.get(cls.superClass);
      if (parent) nodes.push(...this.fieldsOf(parent, parentPath));
      else {
        this.issues.push({
          severity: 'warning',
          kind: 'unresolved',
          line: cls.line,
          message: `A superclasse "${cls.superClass}" de "${cls.name}" não foi informada: seus campos não aparecem.`,
        });
      }
    }
    for (const f of cls.fields) {
      if (f.isStatic) continue;
      const names = new Set(f.annotations.map((a) => a.name));
      if (f.isTransient || names.has('JsonIgnore')) {
        this.issues.push({
          severity: 'info',
          kind: 'unsupported',
          line: f.line,
          message: `Campo "${f.name}" ignorado (${f.isTransient ? 'transient' : '@JsonIgnore'}).`,
        });
        continue;
      }
      const jsonName = f.annotations.find((a) => a.name === 'JsonProperty')?.value;
      const key = jsonName && jsonName.length > 0 ? jsonName : f.name;
      const node = this.typeNode(key, childPath(parentPath, key), f.type, cls);
      if (key !== f.name) node.javaName = f.name;
      node.required = f.annotations.some((a) => REQUIRED_ANNOTATIONS.has(a.name));
      const relevant = f.annotations
        .filter((a) => RELEVANT_ANNOTATIONS.has(a.name))
        .map((a) => `@${a.name}`);
      if (relevant.length) node.annotations = relevant;
      if (PRIMITIVES.has(f.type.name) && f.type.dims === 0) node.nullable = false;
      nodes.push(node);
    }
    return nodes;
  }

  private typeNode(name: string, path: string, type: JavaType, owner: JavaClass): FieldNode {
    const base: FieldNode = { name, path, type: 'any', required: false, nativeType: type.text };
    if (type.dims > 0) {
      const inner: JavaType = {
        ...type,
        dims: type.dims - 1,
        text: type.text.replace(/\[\]$/, ''),
      };
      return this.arrayNode(base, inner, owner);
    }
    if (type.name === 'Optional' && type.args.length === 1) {
      return {
        ...this.typeNode(name, path, type.args[0], owner),
        nullable: true,
        nativeType: type.text,
      };
    }
    if (COLLECTIONS.has(type.name)) {
      const element = type.args[0] ?? { name: 'Object', args: [], dims: 0, text: 'Object' };
      return this.arrayNode(base, element, owner);
    }
    if (MAPS.has(type.name)) {
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        path,
        message: `"${path}" é ${type.text}: mapas não têm campos conhecidos e o valor é tratado como "any".`,
      });
      return base;
    }
    const scalar = SCALARS[type.name];
    if (scalar) return { ...base, type: scalar };
    if (owner.typeParams.includes(type.name)) {
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        path,
        message: `"${path}" usa o parâmetro genérico ${type.name}, tratado como "any".`,
      });
      return base;
    }
    const cls = this.byName.get(type.name);
    if (!cls) {
      this.issues.push({
        severity: 'warning',
        kind: 'unresolved',
        path,
        message: `O tipo "${type.name}" de "${path}" não foi informado: inclua a classe no texto para ver seus campos.`,
      });
      return { ...base, type: 'object', typeName: type.name };
    }
    if (cls.kind === 'enum') {
      return { ...base, type: 'enum', typeName: cls.qualifiedName, enumValues: cls.enumConstants };
    }
    if (cls.kind === 'interface') {
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        path,
        message: `"${path}" usa a interface ${cls.name}, que não declara campos.`,
      });
      return { ...base, type: 'object', typeName: cls.qualifiedName };
    }
    if (this.stack.includes(cls.name)) {
      this.issues.push({
        severity: 'warning',
        kind: 'circular',
        path,
        message: `Referência circular: ${[...this.stack, cls.name].join(' → ')}. A expansão de "${path}" foi interrompida.`,
      });
      return { ...base, type: 'object', typeName: cls.qualifiedName };
    }
    this.stack.push(cls.name);
    const children = this.fieldsOf(cls, path);
    this.stack.pop();
    return { ...base, type: 'object', typeName: cls.qualifiedName, children };
  }

  private arrayNode(base: FieldNode, element: JavaType, owner: JavaClass): FieldNode {
    const itemPath = `${base.path}[*]`;
    const item = this.typeNode('[*]', itemPath, element, owner);
    return {
      ...base,
      type: 'array',
      itemType: item.type,
      typeName: item.typeName,
      children: item.type === 'object' ? item.children : [item],
    };
  }
}

export interface JavaParseResult extends ParseResult {
  packageName?: string;
  classNames: string[];
}

/**
 * Interpreta classes Java. A raiz é a classe indicada em `rootClass`, senão a primeira classe de
 * primeiro nível que nenhuma outra referencia, senão a primeira declarada.
 */
export function parseJavaStructure(text: string, rootClass?: string): JavaParseResult {
  let parser: JavaParser;
  try {
    parser = new JavaParser(text);
    parser.parse();
  } catch (e) {
    if (e instanceof SourceSyntaxError) {
      return {
        root: null,
        rootName: rootClass ?? 'Unknown',
        classNames: [],
        issues: [
          {
            severity: 'error',
            kind: 'syntax',
            message: `Java: ${e.message}`,
            line: e.line,
            column: e.column,
          },
        ],
      };
    }
    throw e;
  }
  const dtos = parser.classes.filter((c) => c.kind === 'class' || c.kind === 'record');
  const classNames = dtos.map((c) => c.name);
  if (dtos.length === 0) {
    return {
      root: null,
      rootName: rootClass ?? 'Unknown',
      classNames,
      packageName: parser.packageName,
      issues: [
        ...parser.issues,
        {
          severity: 'error',
          kind: 'unsupported',
          message: 'Nenhuma classe ou record encontrado no texto Java.',
        },
      ],
    };
  }
  const issues = [...parser.issues];
  const referenced = new Set<string>();
  const collect = (t: JavaType): void => {
    referenced.add(t.name);
    t.args.forEach(collect);
  };
  for (const c of dtos) {
    c.fields.forEach((f) => collect(f.type));
    if (c.superClass) referenced.add(c.superClass);
  }
  const root =
    dtos.find((c) => c.name === rootClass) ??
    dtos.find((c) => !c.qualifiedName.includes('.') && !referenced.has(c.name)) ??
    dtos[0];
  const builder = new SchemaBuilder(parser.classes, issues);
  return {
    root: builder.buildRoot(root),
    rootName: root.name,
    issues,
    classNames,
    packageName: parser.packageName,
  };
}
