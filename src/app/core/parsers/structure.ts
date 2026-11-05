import { JsonValue } from '../models/json.model';
import { StructureDefinition } from '../models/project.model';
import { FieldNode, FieldType, ParseResult } from '../models/schema.model';
import { DEFAULT_LIMITS, parseJsonStructure, ParseLimits } from './json-parser';
import { parseJavaStructure } from './java-parser';
import { parseTypeScriptStructure } from './typescript-parser';

/** Interpreta uma estrutura em qualquer formato e aplica as propriedades definidas pelo usuário. */
export function parseStructure(
  def: StructureDefinition,
  limits: ParseLimits = DEFAULT_LIMITS,
): ParseResult {
  if (def.text.length > limits.maxBytes) {
    return {
      root: null,
      rootName: def.rootName,
      issues: [
        {
          severity: 'error',
          kind: 'limit',
          message: 'O conteúdo excede o limite de tamanho configurado.',
        },
      ],
    };
  }
  let result: ParseResult;
  switch (def.format) {
    case 'json':
      result = parseJsonStructure(def.text, def.rootName, limits);
      break;
    case 'java':
      result = parseJavaStructure(def.text, def.rootName);
      break;
    case 'typescript':
      result = parseTypeScriptStructure(def.text, def.rootName);
      break;
  }
  if (result.root && Object.keys(def.overrides).length > 0) {
    result = { ...result, root: applyOverrides(result.root, def.overrides) };
  }
  return result;
}

function applyOverrides(node: FieldNode, overrides: StructureDefinition['overrides']): FieldNode {
  const o = overrides[node.path];
  const children = node.children?.map((c) => applyOverrides(c, overrides));
  return {
    ...node,
    ...(children ? { children } : {}),
    ...(o?.required !== undefined ? { required: o.required } : {}),
    ...(o?.type ? { type: o.type } : {}),
  };
}

/** Nós sem a raiz, em ordem de exibição, incluindo os pseudo-nós `[*]`. */
export function flattenFields(root: FieldNode | null): FieldNode[] {
  if (!root) return [];
  const out: FieldNode[] = [];
  const visit = (n: FieldNode): void => {
    if (n.path !== '') out.push(n);
    n.children?.forEach(visit);
  };
  visit(root);
  return out;
}

export function indexFields(root: FieldNode | null): Map<string, FieldNode> {
  return new Map(flattenFields(root).map((n) => [n.path, n]));
}

/** Campo sem filhos, ou seja, os que recebem ou fornecem valores simples. */
export function isLeaf(n: FieldNode): boolean {
  return !n.children || n.children.length === 0;
}

const SAMPLE_BY_TYPE: Partial<Record<FieldType, JsonValue>> = {
  string: 'exemplo',
  number: 12.5,
  integer: 1,
  boolean: true,
  date: '2024-01-31',
  datetime: '2024-01-31T10:00:00',
  any: null,
  null: null,
};

/** Gera um JSON de exemplo a partir do schema, para estruturas importadas de Java ou TypeScript. */
export function sampleFromSchema(node: FieldNode | null): JsonValue {
  if (!node) return {};
  switch (node.type) {
    case 'object': {
      const out: { [k: string]: JsonValue } = {};
      for (const c of node.children ?? []) out[c.name] = sampleFromSchema(c);
      return out;
    }
    case 'array': {
      const children = node.children ?? [];
      if (children.length === 0) return [];
      if (children.length === 1 && children[0].name === '[*]')
        return [sampleFromSchema(children[0])];
      const item: { [k: string]: JsonValue } = {};
      for (const c of children) item[c.name] = sampleFromSchema(c);
      return [item];
    }
    case 'enum':
      return node.enumValues?.[0] ?? 'VALOR';
    default:
      return node.sample ?? SAMPLE_BY_TYPE[node.type] ?? null;
  }
}

export { DEFAULT_LIMITS };
export type { ParseLimits };
