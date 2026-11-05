import { CodegenSettings, CodeTargetId, ProjectDocument } from '../models/project.model';
import { generateJavaDtos, generateJavaPlain } from './java-generator';
import { generateMapStruct } from './mapstruct-generator';
import { GeneratedOutput } from './types';
import {
  generateAngularService,
  generateTsInterfaces,
  generateTypeScript,
} from './typescript-generator';

export const CODE_TARGETS: {
  id: CodeTargetId;
  label: string;
  description: string;
  language: 'java' | 'typescript';
}[] = [
  {
    id: 'java-plain',
    label: 'Java puro',
    description: 'Classe mapper sem dependências, com tratamento de nulos e listas.',
    language: 'java',
  },
  {
    id: 'java-mapstruct',
    label: 'Java com MapStruct',
    description: 'Interface @Mapper com @Mapping e métodos auxiliares.',
    language: 'java',
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    description: 'Interfaces e função tipada de transformação.',
    language: 'typescript',
  },
  {
    id: 'angular-service',
    label: 'Angular Service',
    description: 'Serviço @Injectable com os métodos de transformação.',
    language: 'typescript',
  },
  {
    id: 'java-dto',
    label: 'Classes Java DTO',
    description: 'Classes com campos, getters e setters das duas estruturas.',
    language: 'java',
  },
  {
    id: 'ts-interfaces',
    label: 'Interfaces TypeScript',
    description: 'Interfaces das duas estruturas.',
    language: 'typescript',
  },
];

export function generateCode(
  doc: ProjectDocument,
  settings: CodegenSettings = doc.codegen,
): GeneratedOutput {
  switch (settings.target) {
    case 'java-plain':
      return generateJavaPlain(doc, settings);
    case 'java-mapstruct':
      return generateMapStruct(doc, settings);
    case 'typescript':
      return generateTypeScript(doc, settings);
    case 'angular-service':
      return generateAngularService(doc, settings);
    case 'java-dto':
      return generateJavaDtos(doc, settings);
    case 'ts-interfaces':
      return generateTsInterfaces(doc, settings);
  }
}

export type { GeneratedFile, GeneratedOutput } from './types';
