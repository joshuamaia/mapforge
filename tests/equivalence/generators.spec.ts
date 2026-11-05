import { describe, expect, it } from 'vitest';
import { generateCode } from '../../src/app/core/code-generators';
import { EXAMPLES, ExampleDefinition } from '../../src/app/core/examples/examples';
import { JsonValue } from '../../src/app/core/models/json.model';
import { Mapping, TransformStep } from '../../src/app/core/models/mapping.model';
import {
  CodegenSettings,
  defaultCodegen,
  ProjectDocument,
} from '../../src/app/core/models/project.model';
import { TRANSFORMS } from '../../src/app/core/transformations/catalog';
import {
  compileAndRunJava,
  engineOutput,
  javaAvailable,
  loadGeneratedTs,
  mapstructJars,
  normalize,
  typeCheck,
} from './helpers';

const usable = EXAMPLES.filter((e) => e.id !== 'erros');
const settings = (doc: ProjectDocument, over: Partial<CodegenSettings>): CodegenSettings => ({
  ...doc.codegen,
  ...over,
});

function runTs(doc: ProjectDocument, input: JsonValue): JsonValue {
  const out = generateCode(doc, settings(doc, { target: 'typescript', mapperName: 'Generated' }));
  const mod = loadGeneratedTs(out.files[0].content);
  return mod['mapGenerated'](input) as JsonValue;
}

describe('equivalência motor x TypeScript gerado', () => {
  it.each(usable.map((e) => [e.title, e] as const))('%s', (_, example: ExampleDefinition) => {
    const out = generateCode(
      example.document,
      settings(example.document, { target: 'typescript', mapperName: 'Generated' }),
    );
    expect(out.warnings).toEqual([]);
    const input = JSON.parse(example.document.sampleData) as JsonValue;
    expect(runTs(example.document, input)).toEqual(engineOutput(example.document));
    expect(engineOutput(example.document)).toEqual(example.expectedOutput);
  });

  it.each(usable.map((e) => [e.title, e] as const))('%s compila em modo strict', (_, example) => {
    const out = generateCode(
      example.document,
      settings(example.document, { target: 'typescript', mapperName: 'Generated' }),
    );
    expect(typeCheck(out.files[0].content)).toEqual([]);
  });

  it.each(usable.map((e) => [e.title, e] as const))('%s: entrada vazia e nulos', (_, example) => {
    for (const input of [{}, nullify(JSON.parse(example.document.sampleData))] as JsonValue[]) {
      const engine = engineOutput(example.document, input);
      expect(runTs(example.document, input)).toEqual(engine);
    }
  });

  it('Angular Service expõe map e mapList e compila', () => {
    const doc = EXAMPLES.find((e) => e.id === 'api-rest')!.document;
    const out = generateCode(
      doc,
      settings(doc, { target: 'angular-service', mapperName: 'UserCard' }),
    );
    const code = out.files[0].content;
    expect(code).toContain('@Injectable');
    expect(out.files[0].name).toBe('user-card.service.ts');
    const errors = typeCheck(code, {
      '/generated/angular-core.d.ts':
        "declare module '@angular/core' { export function Injectable(o?: unknown): ClassDecorator; }",
    });
    expect(errors).toEqual([]);
    const mod = loadGeneratedTs(code) as unknown as Record<
      string,
      new () => { map(x: unknown): JsonValue; mapList(x: unknown[]): JsonValue[] }
    >;
    const service = new mod['UserCardService']();
    const input = JSON.parse(doc.sampleData);
    expect(service.map(input)).toEqual(engineOutput(doc));
    expect(service.mapList([input])).toEqual([engineOutput(doc)]);
    expect(service.mapList(null as never)).toEqual([]);
  });

  it('interfaces TypeScript compilam', () => {
    for (const e of usable) {
      const out = generateCode(e.document, settings(e.document, { target: 'ts-interfaces' }));
      expect(out.files[0].content).toContain('export interface');
      expect(typeCheck(out.files[0].content)).toEqual([]);
    }
  });

  it('comentários são opcionais', () => {
    const doc = EXAMPLES[0].document;
    const withComments = generateCode(doc, settings(doc, { target: 'typescript', comments: true }))
      .files[0].content;
    const without = generateCode(doc, settings(doc, { target: 'typescript', comments: false }))
      .files[0].content;
    expect(withComments).toContain('// nomeCompleto -> fullName');
    expect(without).not.toContain('// nomeCompleto');
  });
});

/** Documento com todas as transformações, cada uma em um campo próprio. */
function catalogDocument(): { doc: ProjectDocument; input: JsonValue } {
  const input: { [k: string]: JsonValue } = {};
  const target: { [k: string]: JsonValue } = {};
  const mappings: Mapping[] = [];
  const skip = new Set(['coalesce']);
  TRANSFORMS.filter((t) => !skip.has(t.id)).forEach((t, i) => {
    const key = `f${i}`;
    input[key] = t.sample.input;
    target[`r${i}`] = null;
    const step: TransformStep = { id: `s${i}`, transformId: t.id, params: t.sample.params };
    mappings.push({
      id: `m${i}`,
      sourcePath: key,
      targetPath: `r${i}`,
      sourceType: 'any',
      targetType: 'any',
      transforms: [step],
      validationStatus: 'unknown',
    });
  });
  const doc: ProjectDocument = {
    source: { format: 'json', text: JSON.stringify(input), rootName: 'Src', overrides: {} },
    target: { format: 'json', text: JSON.stringify(target), rootName: 'Tgt', overrides: {} },
    sampleData: JSON.stringify(input),
    mappings,
    scopes: [],
    codegen: { ...defaultCodegen(), mapperName: 'Generated' },
  };
  return { doc, input };
}

describe('equivalência no catálogo completo de transformações', () => {
  it('TypeScript gerado reproduz o motor em cada transformação', () => {
    const { doc, input } = catalogDocument();
    const out = generateCode(doc, { ...doc.codegen, target: 'typescript' });
    expect(out.warnings).toEqual([]);
    expect(runTs(doc, input)).toEqual(engineOutput(doc));
  });

  it('valores inválidos resultam em null nos dois lados', () => {
    const { doc } = catalogDocument();
    const bad: { [k: string]: JsonValue } = {};
    doc.mappings.forEach((m) => (bad[m.sourcePath] = '%%%'));
    expect(runTs(doc, bad)).toEqual(engineOutput(doc, bad));
  });
});

function nullify(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(nullify);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).map((k) => [k, nullify(v[k])]));
  return null;
}

describe.runIf(javaAvailable)('equivalência motor x Java gerado (javac real)', () => {
  it.each(usable.map((e) => [e.title, e] as const))('Java puro: %s', (_, example) => {
    const doc = example.document;
    const out = generateCode(
      doc,
      settings(doc, { target: 'java-plain', mapperName: 'GeneratedMapper', comments: true }),
    );
    expect(out.warnings).toEqual([]);
    const input = JSON.parse(doc.sampleData) as JsonValue;
    const result = compileAndRunJava({
      files: out.files,
      doc,
      input,
      mapperCall: (s) => `new GeneratedMapper().map(${s})`,
    });
    expect(normalize(result)).toEqual(normalize(engineOutput(doc)));
  });

  it('Java puro com nulos não lança NullPointerException', () => {
    for (const example of usable) {
      const doc = example.document;
      const out = generateCode(
        doc,
        settings(doc, { target: 'java-plain', mapperName: 'GeneratedMapper' }),
      );
      const input = JSON.parse(doc.sampleData) as { [k: string]: JsonValue };
      // Campo de objeto e listas nulos no primeiro nível.
      const nulled = Object.fromEntries(
        Object.keys(input).map((k) => [k, typeof input[k] === 'object' ? null : input[k]]),
      );
      const result = compileAndRunJava({
        files: out.files,
        doc,
        input: nulled,
        mapperCall: (s) => `new GeneratedMapper().map(${s})`,
      });
      expect(normalize(result)).toEqual(normalize(engineOutput(doc, nulled)));
    }
  });

  it('Java puro: catálogo completo de transformações', () => {
    const { doc, input } = catalogDocument();
    // Transformações sobre objetos e listas de objetos dependem da classe; ficam nos exemplos.
    const unsupportedHere = new Set(['removeEmpty', 'map']);
    const mappings = doc.mappings.filter((m) => !unsupportedHere.has(m.transforms[0].transformId));
    const reduced = { ...doc, mappings };
    const out = generateCode(reduced, {
      ...doc.codegen,
      target: 'java-plain',
      mapperName: 'GeneratedMapper',
    });
    expect(out.warnings).toEqual([]);
    const result = compileAndRunJava({
      files: out.files,
      doc: reduced,
      input,
      mapperCall: (s) => `new GeneratedMapper().map(${s})`,
    });
    const asTyped = (v: JsonValue | undefined): JsonValue | undefined => normalize(v);
    expect(asTyped(result)).toEqual(asTyped(engineOutput(reduced)));
  });

  it('classes DTO geradas compilam', () => {
    for (const example of usable) {
      const doc = example.document;
      const out = generateCode(doc, settings(doc, { target: 'java-dto' }));
      expect(out.files.length).toBeGreaterThan(0);
      for (const f of out.files) expect(f.content).toMatch(/public (class|enum) /);
    }
  });
});

describe.runIf(javaAvailable)('equivalência motor x MapStruct (processador real)', async () => {
  const jars = await mapstructJars();

  it.runIf(jars).each(usable.map((e) => [e.title, e] as const))('MapStruct: %s', (_, example) => {
    const doc = example.document;
    const out = generateCode(
      doc,
      settings(doc, { target: 'java-mapstruct', mapperName: 'GeneratedMapper' }),
    );
    const code = out.files[0].content;
    expect(code).toContain('@Mapper');
    const input = JSON.parse(doc.sampleData) as JsonValue;
    const result = compileAndRunJava({
      files: out.files,
      doc,
      input,
      classpath: [jars!.api],
      processorPath: `${jars!.processor}${process.platform === 'win32' ? ';' : ':'}${jars!.api}`,
      mapperCall: (s) => `new GeneratedMapperImpl().map(${s})`,
    });
    // O que o MapStruct não representa é declarado em warnings e sai do resultado esperado.
    const skipped = out.warnings.flatMap((w) => {
      const m = /Mapeamento \S+ -> (\S+) não é representável/.exec(w);
      return m ? [m[1]] : [];
    });
    const strip = (v: JsonValue | undefined, path: string): JsonValue | undefined => {
      if (Array.isArray(v)) return v.map((x) => strip(x, `${path}[*]`) ?? null);
      if (v && typeof v === 'object') {
        const entries = Object.keys(v).map((k) => [k, path ? `${path}.${k}` : k] as const);
        return Object.fromEntries(
          entries
            .filter(([, p]) => !skipped.includes(p))
            .map(([k, p]) => [k, strip(v[k], p) ?? null]),
        );
      }
      return v;
    };
    expect(normalize(result)).toEqual(normalize(strip(engineOutput(doc), '')));
  });
});
