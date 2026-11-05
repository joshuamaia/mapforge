import { ArrayScope, Mapping } from './mapping.model';
import { FieldType, StructureFormat } from './schema.model';

export interface FieldOverride {
  required?: boolean;
  type?: FieldType;
}

export interface StructureDefinition {
  format: StructureFormat;
  /** Texto da estrutura: JSON de exemplo, classes Java ou interfaces TypeScript. */
  text: string;
  /** Nome amigável da raiz (usado nos geradores). */
  rootName: string;
  /** Propriedades definidas pelo usuário, por caminho. */
  overrides: Record<string, FieldOverride>;
}

export type CodeTargetId =
  'java-plain' | 'java-mapstruct' | 'typescript' | 'angular-service' | 'java-dto' | 'ts-interfaces';

export interface CodegenSettings {
  target: CodeTargetId;
  mapperName: string;
  javaPackage: string;
  comments: boolean;
}

/** Conteúdo versionado pelo undo/redo e salvo em arquivo. */
export interface ProjectDocument {
  source: StructureDefinition;
  target: StructureDefinition;
  /** JSON de entrada usado no preview. */
  sampleData: string;
  mappings: Mapping[];
  scopes: ArrayScope[];
  codegen: CodegenSettings;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  exampleId?: string;
}

export interface MapForgeProject extends ProjectMeta {
  document: ProjectDocument;
}

export interface ExecutionRecord {
  id?: number;
  projectId: string;
  projectName: string;
  executedAt: string;
  durationMs: number;
  mappedFields: number;
  transformations: number;
  errors: number;
  warnings: number;
  ok: boolean;
}

export function defaultCodegen(): CodegenSettings {
  return {
    target: 'typescript',
    mapperName: 'DataMapper',
    javaPackage: 'com.example.mapping',
    comments: true,
  };
}

export function emptyDocument(): ProjectDocument {
  return {
    source: { format: 'json', text: '{\n  \n}\n', rootName: 'Source', overrides: {} },
    target: { format: 'json', text: '{\n  \n}\n', rootName: 'Target', overrides: {} },
    sampleData: '{\n  \n}\n',
    mappings: [],
    scopes: [],
    codegen: defaultCodegen(),
  };
}
