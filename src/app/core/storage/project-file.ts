import {
  CodeTargetId,
  defaultCodegen,
  MapForgeProject,
  ProjectDocument,
} from '../models/project.model';
import { Mapping, ArrayScope } from '../models/mapping.model';
import { isObject, isValidPath, parsePathOrEmpty } from '../mapping-engine/path';
import { byteSize, formatBytes } from '../parsers/json-parser';

/** Versão do formato de arquivo `.mapforge.json`. */
export const FORMAT_VERSION = 1;
export const FORMAT_ID = 'mapforge-project';

export interface ProjectFile {
  format: typeof FORMAT_ID;
  formatVersion: number;
  exportedAt: string;
  metadata: {
    id: string;
    name: string;
    description: string;
    favorite: boolean;
    createdAt: string;
    updatedAt: string;
    exampleId?: string;
  };
  structures: {
    source: ProjectDocument['source'];
    target: ProjectDocument['target'];
    sampleData: string;
  };
  mappings: Mapping[];
  scopes: ArrayScope[];
  settings: { codegen: ProjectDocument['codegen'] };
}

export function toProjectFile(project: MapForgeProject, now = new Date()): ProjectFile {
  const { document: doc } = project;
  return {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    exportedAt: now.toISOString(),
    metadata: {
      id: project.id,
      name: project.name,
      description: project.description,
      favorite: project.favorite,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.exampleId ? { exampleId: project.exampleId } : {}),
    },
    structures: { source: doc.source, target: doc.target, sampleData: doc.sampleData },
    mappings: doc.mappings,
    scopes: doc.scopes,
    settings: { codegen: doc.codegen },
  };
}

export function serializeProject(project: MapForgeProject): string {
  return JSON.stringify(toProjectFile(project), null, 2);
}

export function projectFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'projeto'}.mapforge.json`;
}

export class ProjectImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectImportError';
  }
}

const FORMATS = new Set(['json', 'java', 'typescript']);
const TARGETS = new Set<CodeTargetId>([
  'java-plain',
  'java-mapstruct',
  'typescript',
  'angular-service',
  'java-dto',
  'ts-interfaces',
]);
const FIELD_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'object',
  'array',
  'null',
  'any',
]);

const fail = (message: string): never => {
  throw new ProjectImportError(message);
};

function str(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`Campo "${what}" ausente ou inválido.`);
  return value as string;
}

function checkPath(path: unknown, what: string, allowEmpty: boolean): string {
  const p = str(path, what);
  if (p === '' && allowEmpty) return p;
  try {
    parsePathOrEmpty(p);
  } catch {
    fail(`Caminho inválido em "${what}": ${p}`);
  }
  if (!isValidPath(p)) fail(`Caminho inválido em "${what}": ${p}`);
  return p;
}

function readStructure(value: unknown, what: string): ProjectDocument['source'] {
  if (!isObject(value)) return fail(`Estrutura "${what}" ausente.`);
  const format = str(value['format'], `${what}.format`);
  if (!FORMATS.has(format)) fail(`Formato desconhecido em ${what}: ${format}.`);
  const overrides = value['overrides'];
  if (overrides !== undefined && !isObject(overrides))
    fail(`"${what}.overrides" deve ser um objeto.`);
  return {
    format: format as ProjectDocument['source']['format'],
    text: str(value['text'], `${what}.text`),
    rootName: str(value['rootName'], `${what}.rootName`),
    overrides: (overrides ?? {}) as ProjectDocument['source']['overrides'],
  };
}

function readConditions(value: unknown, what: string): Mapping['conditions'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fail(`"${what}" deve ser uma lista.`);
  return value.map((c, i) => {
    if (!isObject(c)) return fail(`Condição inválida em ${what}[${i}].`);
    return {
      field: str(c['field'], `${what}[${i}].field`),
      operator: str(c['operator'], `${what}[${i}].operator`),
      ...(c['value'] !== undefined ? { value: c['value'] } : {}),
    } as NonNullable<Mapping['conditions']>[number];
  });
}

function readMapping(value: unknown, i: number): Mapping {
  const what = `mappings[${i}]`;
  if (!isObject(value)) return fail(`${what} inválido.`);
  const transforms = value['transforms'] ?? [];
  if (!Array.isArray(transforms)) fail(`${what}.transforms deve ser uma lista.`);
  const sourceType = str(value['sourceType'], `${what}.sourceType`);
  const targetType = str(value['targetType'], `${what}.targetType`);
  if (!FIELD_TYPES.has(sourceType) || !FIELD_TYPES.has(targetType))
    fail(`${what}: tipo desconhecido.`);
  const conditions = readConditions(value['conditions'], `${what}.conditions`);
  return {
    id: str(value['id'], `${what}.id`),
    sourcePath: checkPath(value['sourcePath'], `${what}.sourcePath`, true),
    targetPath: checkPath(value['targetPath'], `${what}.targetPath`, false),
    sourceType: sourceType as Mapping['sourceType'],
    targetType: targetType as Mapping['targetType'],
    transforms: (transforms as unknown[]).map((t, j) => {
      if (!isObject(t)) return fail(`${what}.transforms[${j}] inválida.`);
      const params = t['params'] ?? {};
      if (!isObject(params)) fail(`${what}.transforms[${j}].params inválido.`);
      return {
        id: str(t['id'], `${what}.transforms[${j}].id`),
        transformId: str(t['transformId'], `${what}.transforms[${j}].transformId`),
        params: params as Mapping['transforms'][number]['params'],
        ...(t['disabled'] === true ? { disabled: true } : {}),
      };
    }),
    ...(value['defaultValue'] !== undefined ? { defaultValue: value['defaultValue'] } : {}),
    ...(conditions ? { conditions } : {}),
    validationStatus: 'unknown',
  };
}

function readScope(value: unknown, i: number): ArrayScope {
  const what = `scopes[${i}]`;
  if (!isObject(value)) return fail(`${what} inválido.`);
  const sort = value['sort'];
  if (
    sort !== undefined &&
    (!isObject(sort) || !['asc', 'desc'].includes(String(sort['direction'])))
  ) {
    fail(`${what}.sort inválido.`);
  }
  const filter = readConditions(value['filter'], `${what}.filter`);
  return {
    id: str(value['id'], `${what}.id`),
    sourcePath: checkPath(value['sourcePath'], `${what}.sourcePath`, false),
    targetPath: checkPath(value['targetPath'], `${what}.targetPath`, false),
    ...(filter ? { filter } : {}),
    ...(sort ? { sort: sort as unknown as NonNullable<ArrayScope['sort']> } : {}),
    ...(typeof value['distinctBy'] === 'string' ? { distinctBy: value['distinctBy'] } : {}),
  };
}

/** Valida versão e conteúdo. Nada do arquivo é executado; tudo é tratado como dado. */
export function parseProjectFile(text: string, maxBytes = 20 * 1024 * 1024): MapForgeProject {
  if (byteSize(text) > maxBytes) fail(`O arquivo excede o limite de ${formatBytes(maxBytes)}.`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('O arquivo não contém JSON válido.');
  }
  if (!isObject(data)) return fail('O arquivo não é um projeto MapForge.');
  if (data['format'] !== FORMAT_ID) fail('O arquivo não é um projeto MapForge (campo "format").');
  const version = data['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('Versão do formato ausente ou inválida.');
  }
  if ((version as number) > FORMAT_VERSION) {
    fail(
      `O arquivo usa a versão ${String(version)} do formato; esta aplicação lê até a versão ${FORMAT_VERSION}.`,
    );
  }
  const meta = data['metadata'];
  if (!isObject(meta)) return fail('Metadados ausentes.');
  const structures = data['structures'];
  if (!isObject(structures)) return fail('Estruturas de origem e destino ausentes.');
  if (!Array.isArray(data['mappings'])) fail('A lista de mapeamentos está ausente.');
  const settings = isObject(data['settings']) ? data['settings'] : {};
  const codegen = isObject(settings['codegen']) ? settings['codegen'] : {};
  const defaults = defaultCodegen();
  const target = codegen['target'] as CodeTargetId;
  const name = str(meta['name'], 'metadata.name').trim();
  if (name === '') fail('O projeto precisa de um nome.');

  return {
    id: str(meta['id'], 'metadata.id'),
    name,
    description: typeof meta['description'] === 'string' ? meta['description'] : '',
    favorite: meta['favorite'] === true,
    createdAt: str(meta['createdAt'], 'metadata.createdAt'),
    updatedAt: str(meta['updatedAt'], 'metadata.updatedAt'),
    ...(typeof meta['exampleId'] === 'string' ? { exampleId: meta['exampleId'] } : {}),
    document: {
      source: readStructure(structures['source'], 'source'),
      target: readStructure(structures['target'], 'target'),
      sampleData: str(structures['sampleData'], 'structures.sampleData'),
      mappings: (data['mappings'] as unknown[]).map(readMapping),
      scopes: Array.isArray(data['scopes']) ? data['scopes'].map(readScope) : [],
      codegen: {
        target: TARGETS.has(target) ? target : defaults.target,
        mapperName:
          typeof codegen['mapperName'] === 'string' ? codegen['mapperName'] : defaults.mapperName,
        javaPackage:
          typeof codegen['javaPackage'] === 'string'
            ? codegen['javaPackage']
            : defaults.javaPackage,
        comments:
          typeof codegen['comments'] === 'boolean' ? codegen['comments'] : defaults.comments,
      },
    },
  };
}
