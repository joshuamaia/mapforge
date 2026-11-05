import { FieldNode, FieldType, ParseIssue, ParseResult } from '../models/schema.model';
import { childPath } from '../mapping-engine/path';
import { SourceSyntaxError, tokenize, TokenStream } from './tokenizer';

/**
 * Parser recursive descent do subconjunto de TypeScript usado para descrever dados: interfaces,
 * type aliases, enums, arrays, propriedades opcionais, unions simples e objetos aninhados.
 * Construções fora desse escopo geram aviso explícito e o campo vira "any".
 */

type TsType =
  | { kind: 'primitive'; type: FieldType; text: string }
  | { kind: 'null' | 'undefined' }
  | { kind: 'literal'; value: string; literal: 'string' | 'number' | 'boolean' }
  | { kind: 'array'; element: TsType }
  | { kind: 'object'; members: TsMember[] }
  | { kind: 'ref'; name: string; args: TsType[] }
  | { kind: 'union'; types: TsType[] }
  | { kind: 'unsupported'; text: string; reason: string };

interface TsMember {
  name: string;
  optional: boolean;
  type: TsType;
  line: number;
}

interface TsDecl {
  name: string;
  kind: 'interface' | 'alias' | 'enum';
  extends: string[];
  typeParams: string[];
  type: TsType;
  enumValues: string[];
  line: number;
}

const PRIMITIVE_TYPES: Record<string, FieldType> = {
  string: 'string',
  number: 'number',
  bigint: 'integer',
  boolean: 'boolean',
  any: 'any',
  unknown: 'any',
  object: 'any',
  Date: 'datetime',
};

class TsParser {
  readonly decls: TsDecl[] = [];
  readonly issues: ParseIssue[] = [];
  private readonly s: TokenStream;

  constructor(text: string) {
    this.s = new TokenStream(tokenize(text));
  }

  parse(): void {
    const s = this.s;
    while (!s.atEnd) {
      if (s.accept(';')) continue;
      if (s.is('import')) {
        s.skipUntil(';', 'export', 'interface', 'type', 'enum');
        s.accept(';');
        continue;
      }
      s.accept('export');
      s.accept('default');
      s.accept('declare');
      if (s.is('const') && s.peek().text === 'enum') s.next();
      if (s.is('interface')) this.parseInterface();
      else if (s.is('type') && s.peek().kind === 'ident') this.parseAlias();
      else if (s.is('enum')) this.parseEnum();
      else this.skipUnsupported();
    }
  }

  private skipUnsupported(): void {
    const s = this.s;
    const start = s.current;
    if (start.kind !== 'ident') s.fail(`Declaração inesperada: "${s.describe()}".`);
    const what = start.text;
    s.next();
    let depth = 0;
    while (!s.atEnd) {
      if (s.is('{') || s.is('(')) depth++;
      else if (s.is('}') || s.is(')')) {
        depth--;
        if (depth === 0 && s.is('}')) {
          s.next();
          break;
        }
      } else if (depth === 0 && s.is(';')) {
        s.next();
        break;
      }
      s.next();
    }
    this.issues.push({
      severity: 'warning',
      kind: 'unsupported',
      line: start.line,
      message: `Declaração "${what}" não é suportada e foi ignorada: use interface, type ou enum.`,
    });
  }

  private parseInterface(): void {
    const s = this.s;
    s.expect('interface');
    const name = s.expectIdent('o nome da interface');
    const typeParams = this.parseTypeParams();
    const parents: string[] = [];
    if (s.accept('extends')) {
      do {
        parents.push(s.expectIdent('o nome da interface base').text);
        if (s.is('<')) s.skipBalanced('<', '>');
      } while (s.accept(','));
    }
    this.decls.push({
      name: name.text,
      kind: 'interface',
      extends: parents,
      typeParams,
      type: this.parseObjectType(),
      enumValues: [],
      line: name.line,
    });
  }

  private parseAlias(): void {
    const s = this.s;
    s.expect('type');
    const name = s.expectIdent('o nome do tipo');
    const typeParams = this.parseTypeParams();
    s.expect('=');
    const type = this.parseType();
    s.accept(';');
    this.decls.push({
      name: name.text,
      kind: 'alias',
      extends: [],
      typeParams,
      type,
      enumValues: [],
      line: name.line,
    });
  }

  private parseEnum(): void {
    const s = this.s;
    s.expect('enum');
    const name = s.expectIdent('o nome do enum');
    s.expect('{');
    const values: string[] = [];
    while (!s.is('}')) {
      const member = s.next();
      let value = member.text;
      if (s.accept('=')) {
        if (s.current.kind === 'string' || s.current.kind === 'number') value = s.current.text;
        s.skipUntil(',', '}');
      }
      values.push(value);
      if (!s.accept(',')) break;
    }
    s.expect('}');
    this.decls.push({
      name: name.text,
      kind: 'enum',
      extends: [],
      typeParams: [],
      type: { kind: 'primitive', type: 'enum', text: name.text },
      enumValues: values,
      line: name.line,
    });
  }

  private parseTypeParams(): string[] {
    const s = this.s;
    if (!s.accept('<')) return [];
    const names: string[] = [];
    do {
      names.push(s.expectIdent('o parâmetro de tipo').text);
      if (s.accept('extends')) this.parseType();
      if (s.accept('=')) this.parseType();
    } while (s.accept(','));
    s.expect('>');
    return names;
  }

  private parseObjectType(): TsType {
    const s = this.s;
    s.expect('{');
    const members: TsMember[] = [];
    while (!s.is('}')) {
      if (s.atEnd) s.fail('Fim do arquivo dentro de um objeto: falta "}".');
      if (s.accept(';') || s.accept(',')) continue;
      const member = this.parseMember();
      if (member) members.push(member);
    }
    s.expect('}');
    return { kind: 'object', members };
  }

  private parseMember(): TsMember | null {
    const s = this.s;
    const start = s.current;
    if (s.is('readonly') && s.peek().text !== ':' && s.peek().text !== '?') s.next();
    if (s.is('[')) {
      s.skipBalanced('[', ']');
      s.accept('?');
      if (s.accept(':')) this.parseType();
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        line: start.line,
        message: 'Index signature ignorada: não há campos conhecidos para mapear.',
      });
      return null;
    }
    if (s.current.kind !== 'ident' && s.current.kind !== 'string') {
      s.fail(`Esperado nome de propriedade, encontrado "${s.describe()}".`);
    }
    const name = s.next().text;
    const optional = s.accept('?');
    if (s.is('(') || s.is('<')) {
      if (s.is('<')) s.skipBalanced('<', '>');
      s.skipBalanced('(', ')');
      if (s.accept(':')) this.parseType();
      this.issues.push({
        severity: 'info',
        kind: 'unsupported',
        line: start.line,
        message: `Método "${name}" ignorado: apenas propriedades de dados são mapeadas.`,
      });
      return null;
    }
    s.expect(':');
    return { name, optional, type: this.parseType(), line: start.line };
  }

  private parseType(): TsType {
    const s = this.s;
    s.accept('|');
    const first = this.parseIntersection();
    if (!s.is('|')) return first;
    const types = [first];
    while (s.accept('|')) types.push(this.parseIntersection());
    return { kind: 'union', types };
  }

  private parseIntersection(): TsType {
    const s = this.s;
    const first = this.parsePostfix();
    if (!s.is('&')) return first;
    while (s.accept('&')) this.parsePostfix();
    return { kind: 'unsupported', text: 'A & B', reason: 'intersection types não são suportados' };
  }

  private parsePostfix(): TsType {
    const s = this.s;
    let type = this.parsePrimary();
    while (s.is('[') && s.peek().text === ']') {
      s.next();
      s.next();
      type = { kind: 'array', element: type };
    }
    return type;
  }

  private parsePrimary(): TsType {
    const s = this.s;
    const t = s.current;
    if (t.kind === 'string') {
      s.next();
      return { kind: 'literal', value: t.text, literal: 'string' };
    }
    if (t.kind === 'number') {
      s.next();
      return { kind: 'literal', value: t.text, literal: 'number' };
    }
    if (s.is('{')) return this.parseObjectType();
    if (s.is('(')) {
      const afterParen = this.looksLikeFunctionType();
      if (afterParen) {
        s.skipBalanced('(', ')');
        s.expect('=>');
        this.parseType();
        return {
          kind: 'unsupported',
          text: 'function',
          reason: 'tipos de função não são dados mapeáveis',
        };
      }
      s.next();
      const inner = this.parseType();
      s.expect(')');
      return inner;
    }
    if (s.is('[')) {
      s.skipBalanced('[', ']');
      return { kind: 'unsupported', text: 'tuple', reason: 'tuplas não são suportadas' };
    }
    if (t.kind !== 'ident') s.fail(`Tipo inesperado: "${s.describe()}".`);
    s.next();
    if (t.text === 'null') return { kind: 'null' };
    if (t.text === 'undefined' || t.text === 'void' || t.text === 'never')
      return { kind: 'undefined' };
    if (t.text === 'true' || t.text === 'false')
      return { kind: 'literal', value: t.text, literal: 'boolean' };
    if (t.text === 'readonly') return this.parsePostfix();
    if (t.text === 'keyof' || t.text === 'typeof') {
      this.parsePostfix();
      return { kind: 'unsupported', text: t.text, reason: `o operador ${t.text} não é suportado` };
    }
    let name = t.text;
    while (s.is('.') && s.peek().kind === 'ident') {
      s.next();
      name = s.next().text;
    }
    const args: TsType[] = [];
    if (s.accept('<')) {
      args.push(this.parseType());
      while (s.accept(',')) args.push(this.parseType());
      s.expect('>');
    }
    const primitive = PRIMITIVE_TYPES[name];
    if (primitive && args.length === 0) return { kind: 'primitive', type: primitive, text: name };
    if ((name === 'Array' || name === 'ReadonlyArray' || name === 'Set') && args.length === 1) {
      return { kind: 'array', element: args[0] };
    }
    return { kind: 'ref', name, args };
  }

  private looksLikeFunctionType(): boolean {
    // ( ) =>  ou ( nome : ...  ou ( nome ? ...  ou ( ...
    const a = this.s.peek(1);
    const b = this.s.peek(2);
    return (
      a.text === ')' ||
      a.text === '...' ||
      (a.kind === 'ident' && (b.text === ':' || b.text === '?' || b.text === ','))
    );
  }
}

class TsSchemaBuilder {
  private readonly byName = new Map<string, TsDecl>();
  private readonly stack: string[] = [];

  constructor(
    decls: TsDecl[],
    private readonly issues: ParseIssue[],
  ) {
    for (const d of decls) this.byName.set(d.name, d);
  }

  buildRoot(decl: TsDecl): FieldNode | null {
    this.stack.push(decl.name);
    const node = this.declNode(decl, decl.name, '');
    this.stack.pop();
    return node;
  }

  private declNode(decl: TsDecl, name: string, path: string): FieldNode {
    if (decl.kind === 'enum') {
      return {
        name,
        path,
        type: 'enum',
        required: false,
        typeName: decl.name,
        nativeType: decl.name,
        enumValues: decl.enumValues,
      };
    }
    if (decl.kind === 'interface') {
      return {
        name,
        path,
        type: 'object',
        required: false,
        typeName: decl.name,
        nativeType: decl.name,
        children: this.membersWithBases(decl, path),
      };
    }
    const node = this.typeNode(name, path, decl.type);
    return node.type === 'object' || node.type === 'array'
      ? { ...node, typeName: node.typeName ?? decl.name, nativeType: decl.name }
      : { ...node, nativeType: decl.name };
  }

  private membersWithBases(decl: TsDecl, path: string): FieldNode[] {
    const nodes: FieldNode[] = [];
    for (const parent of decl.extends) {
      const base = this.byName.get(parent);
      if (base && base.kind === 'interface') nodes.push(...this.membersWithBases(base, path));
      else {
        this.issues.push({
          severity: 'warning',
          kind: 'unresolved',
          line: decl.line,
          message: `A interface base "${parent}" de "${decl.name}" não foi informada: seus campos não aparecem.`,
        });
      }
    }
    if (decl.type.kind === 'object') nodes.push(...this.membersOf(decl.type.members, path));
    return nodes;
  }

  private membersOf(members: TsMember[], path: string): FieldNode[] {
    return members.map((m) => {
      const node = this.typeNode(m.name, childPath(path, m.name), m.type);
      return { ...node, required: !m.optional };
    });
  }

  private typeNode(name: string, path: string, type: TsType): FieldNode {
    const base: FieldNode = { name, path, type: 'any', required: false };
    switch (type.kind) {
      case 'primitive':
        return { ...base, type: type.type, nativeType: type.text };
      case 'null':
      case 'undefined':
        return { ...base, type: 'null', nullable: true, nativeType: type.kind };
      case 'literal':
        if (type.literal === 'string')
          return { ...base, type: 'enum', enumValues: [type.value], nativeType: `'${type.value}'` };
        return { ...base, type: type.literal, nativeType: type.value };
      case 'array': {
        const item = this.typeNode('[*]', `${path}[*]`, type.element);
        return {
          ...base,
          type: 'array',
          itemType: item.type,
          typeName: item.typeName,
          nativeType: `${item.nativeType ?? 'object'}[]`,
          children: item.type === 'object' ? item.children : [item],
        };
      }
      case 'object':
        return { ...base, type: 'object', children: this.membersOf(type.members, path) };
      case 'union':
        return this.unionNode(base, type.types);
      case 'ref':
        return this.refNode(base, type.name, type.args);
      case 'unsupported':
        this.issues.push({
          severity: 'warning',
          kind: 'unsupported',
          path,
          message: `"${path}": ${type.reason}. O campo foi tratado como "any".`,
        });
        return { ...base, nativeType: type.text };
    }
  }

  private unionNode(base: FieldNode, types: TsType[]): FieldNode {
    const concrete = types.filter((t) => t.kind !== 'null' && t.kind !== 'undefined');
    const nullable = concrete.length !== types.length;
    if (concrete.length === 0) return { ...base, type: 'null', nullable: true };
    if (concrete.length === 1) {
      const node = this.typeNode(base.name, base.path, concrete[0]);
      return nullable
        ? { ...node, nullable: true, nativeType: `${node.nativeType ?? 'object'} | null` }
        : node;
    }
    if (concrete.every((t) => t.kind === 'literal' && t.literal === 'string')) {
      const values = concrete.map((t) => (t as { value: string }).value);
      return {
        ...base,
        type: 'enum',
        enumValues: values,
        nativeType: values.map((v) => `'${v}'`).join(' | '),
        ...(nullable ? { nullable } : {}),
      };
    }
    const nodes = concrete.map((t) => this.typeNode(base.name, base.path, t));
    const first = nodes[0].type;
    if (nodes.every((n) => n.type === first) && first !== 'object' && first !== 'array') {
      return { ...base, type: first, ...(nullable ? { nullable } : {}) };
    }
    if (nodes.every((n) => n.type === 'number' || n.type === 'integer'))
      return { ...base, type: 'number' };
    this.issues.push({
      severity: 'info',
      kind: 'unsupported',
      path: base.path,
      message: `"${base.path}" é uma union de tipos diferentes e foi tratada como "any".`,
    });
    return {
      ...base,
      type: 'any',
      nativeType: nodes.map((n) => n.nativeType ?? n.type).join(' | '),
    };
  }

  private refNode(base: FieldNode, name: string, args: TsType[]): FieldNode {
    const decl = this.byName.get(name);
    if (!decl) {
      this.issues.push({
        severity: 'warning',
        kind:
          name === 'Record' || name === 'Partial' || name === 'Map' ? 'unsupported' : 'unresolved',
        path: base.path,
        message:
          name === 'Record' || name === 'Partial' || name === 'Map'
            ? `"${base.path}" usa ${name}<...>, sem campos conhecidos: tratado como "any".`
            : `O tipo "${name}" de "${base.path}" não foi informado: inclua-o no texto para ver seus campos.`,
      });
      return { ...base, nativeType: name };
    }
    if (decl.typeParams.length > 0 || args.length > 0) {
      this.issues.push({
        severity: 'warning',
        kind: 'unsupported',
        path: base.path,
        message: `"${base.path}" usa o tipo genérico ${name}: tratado como "any".`,
      });
      return { ...base, nativeType: name };
    }
    if (this.stack.includes(name)) {
      this.issues.push({
        severity: 'warning',
        kind: 'circular',
        path: base.path,
        message: `Referência circular: ${[...this.stack, name].join(' → ')}. A expansão de "${base.path}" foi interrompida.`,
      });
      return { ...base, type: 'object', typeName: name, nativeType: name };
    }
    this.stack.push(name);
    const node = this.declNode(decl, base.name, base.path);
    this.stack.pop();
    return node;
  }
}

export function parseTypeScriptStructure(text: string, rootType?: string): ParseResult {
  let parser: TsParser;
  try {
    parser = new TsParser(text);
    parser.parse();
  } catch (e) {
    if (e instanceof SourceSyntaxError) {
      return {
        root: null,
        rootName: rootType ?? 'Unknown',
        issues: [
          {
            severity: 'error',
            kind: 'syntax',
            message: `TypeScript: ${e.message}`,
            line: e.line,
            column: e.column,
          },
        ],
      };
    }
    throw e;
  }
  const candidates = parser.decls.filter((d) => d.kind !== 'enum');
  if (candidates.length === 0) {
    return {
      root: null,
      rootName: rootType ?? 'Unknown',
      issues: [
        ...parser.issues,
        {
          severity: 'error',
          kind: 'unsupported',
          message: 'Nenhuma interface ou type alias encontrado.',
        },
      ],
    };
  }
  const referenced = new Set<string>();
  const collect = (t: TsType): void => {
    if (t.kind === 'ref') {
      referenced.add(t.name);
      t.args.forEach(collect);
    } else if (t.kind === 'array') collect(t.element);
    else if (t.kind === 'object') t.members.forEach((m) => collect(m.type));
    else if (t.kind === 'union') t.types.forEach(collect);
  };
  for (const d of candidates) {
    collect(d.type);
    d.extends.forEach((e) => referenced.add(e));
  }
  const root =
    candidates.find((d) => d.name === rootType) ??
    candidates.find((d) => !referenced.has(d.name)) ??
    candidates[0];
  const issues = [...parser.issues];
  const builder = new TsSchemaBuilder(parser.decls, issues);
  const node = builder.buildRoot(root);
  if (node && node.type !== 'object' && node.type !== 'array') {
    return {
      root: null,
      rootName: root.name,
      issues: [
        ...issues,
        {
          severity: 'error',
          kind: 'unsupported',
          message: `O tipo "${root.name}" não descreve um objeto.`,
          line: root.line,
        },
      ],
    };
  }
  return { root: node, rootName: root.name, issues };
}
