import { FieldNode } from '../models/schema.model';
import { camelCase, hasObjectItems, pascalCase, TypeNamer } from './plan';

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
]);

const IMPORTS: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  RoundingMode: 'java.math.RoundingMode',
  Normalizer: 'java.text.Normalizer',
  Instant: 'java.time.Instant',
  LocalDate: 'java.time.LocalDate',
  LocalDateTime: 'java.time.LocalDateTime',
  OffsetDateTime: 'java.time.OffsetDateTime',
  ZoneId: 'java.time.ZoneId',
  ZoneOffset: 'java.time.ZoneOffset',
  ZonedDateTime: 'java.time.ZonedDateTime',
  DateTimeFormatter: 'java.time.format.DateTimeFormatter',
  ArrayList: 'java.util.ArrayList',
  Collection: 'java.util.Collection',
  HashSet: 'java.util.HashSet',
  LinkedHashMap: 'java.util.LinkedHashMap',
  LinkedHashSet: 'java.util.LinkedHashSet',
  List: 'java.util.List',
  Locale: 'java.util.Locale',
  Map: 'java.util.Map',
  Optional: 'java.util.Optional',
  Set: 'java.util.Set',
  UUID: 'java.util.UUID',
  Function: 'java.util.function.Function',
  Predicate: 'java.util.function.Predicate',
  Matcher: 'java.util.regex.Matcher',
  Pattern: 'java.util.regex.Pattern',
  JsonProperty: 'com.fasterxml.jackson.annotation.JsonProperty',
  Mapper: 'org.mapstruct.Mapper',
  Mapping: 'org.mapstruct.Mapping',
  Named: 'org.mapstruct.Named',
  ReportingPolicy: 'org.mapstruct.ReportingPolicy',
};

/** Linhas de import para os tipos realmente mencionados no código. */
export function importsFor(code: string): string[] {
  const stripped = code
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.entries(IMPORTS)
    .filter(([name]) => new RegExp(`(?<![.\\w])${name}\\b`).test(stripped))
    .map(([, full]) => `import ${full};`)
    .sort();
}

export function javaFieldName(node: FieldNode): string {
  if (node.javaName) return node.javaName;
  const name = /^[A-Za-z_$][\w$]*$/.test(node.name) ? node.name : camelCase(node.name);
  return JAVA_KEYWORDS.has(name) ? `${name}Value` : name;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function getterName(node: FieldNode): string {
  const field = javaFieldName(node);
  const isPrimitiveBool = node.nativeType === 'boolean';
  return `${isPrimitiveBool ? 'is' : 'get'}${capitalize(field)}`;
}

export function setterName(node: FieldNode): string {
  return `set${capitalize(javaFieldName(node))}`;
}

const JAVA_SIMPLE: Record<string, string> = {
  string: 'String',
  integer: 'Long',
  number: 'BigDecimal',
  boolean: 'Boolean',
  date: 'LocalDate',
  any: 'Object',
  null: 'Object',
};

function hasOffset(node: FieldNode): boolean {
  return typeof node.sample === 'string' && /(Z|[+-]\d{2}:?\d{2})$/.test(node.sample);
}

/** Tipo Java de um campo: o declarado, em DTOs Java; senão derivado do schema. */
export function javaType(node: FieldNode, namer: TypeNamer, fromJava: boolean): string {
  if (fromJava && node.nativeType && !node.nativeType.startsWith('? ')) {
    return node.nativeType.replace(/^Optional<(.*)>$/, '$1');
  }
  switch (node.type) {
    case 'object':
      return namer.nameOf(node);
    case 'enum':
      return node.typeName ?? 'String';
    case 'datetime':
      return hasOffset(node) ? 'OffsetDateTime' : 'LocalDateTime';
    case 'array': {
      const children = node.children ?? [];
      if (children.length === 0) return 'List<Object>';
      if (hasObjectItems(node)) return `List<${namer.nameOf(node)}>`;
      return `List<${boxed(javaType(children[0], namer, false))}>`;
    }
    default:
      return JAVA_SIMPLE[node.type] ?? 'Object';
  }
}

const BOXES: Record<string, string> = {
  byte: 'Byte',
  short: 'Short',
  int: 'Integer',
  long: 'Long',
  float: 'Float',
  double: 'Double',
  boolean: 'Boolean',
  char: 'Character',
};

export function boxed(type: string): string {
  return BOXES[type] ?? type;
}

export function isPrimitive(type: string): boolean {
  return type in BOXES;
}

export function javaClassFileName(name: string): string {
  return `${pascalCase(name) || 'Generated'}.java`;
}

export function javaString(v: string): string {
  return JSON.stringify(v).replace(/\\u2028/g, '\\u2028');
}
