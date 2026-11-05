import { JsonValue } from './json.model';

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'object'
  | 'array'
  | 'null'
  | 'any';

/** Nó da árvore de campos, comum a JSON, Java e TypeScript. */
export interface FieldNode {
  /** Chave no JSON. Itens de array usam o pseudo-nome `[*]`. */
  name: string;
  /** Caminho canônico, por exemplo `pedidos[*].codigo`. A raiz usa string vazia. */
  path: string;
  type: FieldType;
  required: boolean;
  nullable?: boolean;
  /** Tipo do elemento, quando `type === 'array'`. */
  itemType?: FieldType;
  /** Nome da classe/interface, de objetos e de elementos de arrays de objetos. */
  typeName?: string;
  /** Tipo como foi declarado na linguagem de origem (`List<Item>`, `string | null`). */
  nativeType?: string;
  /** Nome do campo Java quando difere da chave JSON (`@JsonProperty`). */
  javaName?: string;
  enumValues?: string[];
  annotations?: string[];
  sample?: JsonValue;
  children?: FieldNode[];
}

export type StructureFormat = 'json' | 'java' | 'typescript';

export interface ParseIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  column?: number;
  /** Categoria para os diagnósticos. `circular` indica referência circular de tipos. */
  kind?: 'syntax' | 'unsupported' | 'circular' | 'unresolved' | 'limit';
  path?: string;
}

export interface ParseResult {
  root: FieldNode | null;
  rootName: string;
  issues: ParseIssue[];
}
