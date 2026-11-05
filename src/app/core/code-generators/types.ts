export interface GeneratedFile {
  name: string;
  language: 'typescript' | 'java';
  content: string;
}

export interface GeneratedOutput {
  files: GeneratedFile[];
  /** O que não pôde ser representado no código gerado. */
  warnings: string[];
}
