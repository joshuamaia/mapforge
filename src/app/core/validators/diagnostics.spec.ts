import { JsonValue } from '../models/json.model';
import { ArrayScope, Mapping, TransformStep } from '../models/mapping.model';
import { DiagnosticCode } from '../models/diagnostic.model';
import { parseJavaStructure } from '../parsers/java-parser';
import { parseStructure } from '../parsers/structure';
import { runDiagnostics, statusFromDiagnostics } from './diagnostics';
import { typeCompatibility } from './type-compat';

const json = (value: unknown) =>
  parseStructure({ format: 'json', text: JSON.stringify(value), rootName: 'R', overrides: {} });

let n = 0;
const map = (sourcePath: string, targetPath: string, extra: Partial<Mapping> = {}): Mapping => ({
  id: `m${++n}`,
  sourcePath,
  targetPath,
  sourceType: 'any',
  targetType: 'any',
  transforms: [],
  validationStatus: 'unknown',
  ...extra,
});
const step = (transformId: string, params: TransformStep['params'] = {}): TransformStep => ({
  id: `s${++n}`,
  transformId,
  params,
});

function diagnose(
  source: unknown,
  target: unknown,
  mappings: Mapping[],
  extra: { scopes?: ArrayScope[]; required?: string[]; data?: JsonValue } = {},
) {
  const tgt = parseStructure({
    format: 'json',
    text: JSON.stringify(target),
    rootName: 'T',
    overrides: Object.fromEntries((extra.required ?? []).map((p) => [p, { required: true }])),
  });
  return runDiagnostics({
    mappings,
    scopes: extra.scopes,
    source: json(source),
    target: tgt,
    sampleData: extra.data,
  });
}
const codes = (d: { code: DiagnosticCode }[]) => d.map((x) => x.code);

describe('compatibilidade de tipos', () => {
  it.each([
    ['string', 'string', 'exact'],
    ['integer', 'number', 'safe'],
    ['number', 'integer', 'lossy'],
    ['string', 'number', 'lossy'],
    ['datetime', 'date', 'lossy'],
    ['boolean', 'object', 'incompatible'],
    ['object', 'string', 'incompatible'],
    ['any', 'object', 'safe'],
  ] as const)('%s → %s = %s', (a, b, expected) => {
    expect(typeCompatibility(a, b)).toBe(expected);
  });
});

describe('Mapping Diagnostics', () => {
  it('mapeamento correto não gera diagnóstico', () => {
    expect(diagnose({ a: 'x' }, { b: 'y' }, [map('a', 'b')])).toEqual([]);
  });

  it('campos de origem e destino inexistentes', () => {
    const d = diagnose({ a: 1 }, { b: 1 }, [map('x', 'b'), map('a', 'y')]);
    expect(codes(d)).toEqual(['source-missing', 'target-missing']);
    expect(d[0]).toMatchObject({ severity: 'error', field: 'x' });
    expect(d[0].suggestion).not.toBe('');
  });

  it('caminhos inválidos', () => {
    const d = diagnose({ a: 1 }, { b: 1 }, [map('a..b', 'b'), map('a', 'b[')]);
    expect(codes(d)).toEqual(['source-missing', 'target-missing']);
  });

  it('tipos incompatíveis', () => {
    const m = map('a', 'b');
    const d = diagnose({ a: true }, { b: { c: 1 } }, [m]);
    expect(d[0]).toMatchObject({ code: 'type-incompatible', severity: 'error', mappingId: m.id });
  });

  it('conversão perigosa é warning e transformação explícita resolve', () => {
    expect(codes(diagnose({ a: 'x' }, { b: 1 }, [map('a', 'b')]))).toEqual(['unsafe-conversion']);
    expect(
      diagnose({ a: '1' }, { b: 1.5 }, [map('a', 'b', { transforms: [step('stringToNumber')] })]),
    ).toEqual([]);
    expect(codes(diagnose({ a: 1.5 }, { b: 1 }, [map('a', 'b')]))).toEqual(['unsafe-conversion']);
  });

  it('o tipo final considera toda a cadeia', () => {
    const d = diagnose({ a: 1 }, { b: true }, [
      map('a', 'b', { transforms: [step('numberToString')] }),
    ]);
    expect(codes(d)).toEqual(['unsafe-conversion']);
    expect(
      diagnose({ a: 1 }, { b: true }, [map('a', 'b', { transforms: [step('numberToBoolean')] })]),
    ).toEqual([]);
  });

  it('mapeamentos duplicados', () => {
    const d = diagnose({ a: 1, c: 1 }, { b: 1 }, [map('a', 'b'), map('a', 'b')]);
    expect(codes(d)).toEqual(['duplicate-mapping']);
    expect(d[0].severity).toBe('error');
    const other = diagnose({ a: 1, c: 1 }, { b: 1 }, [map('a', 'b'), map('c', 'b')]);
    expect(other[0].message).toContain('último');
  });

  it('origens alternativas com condições são apenas informativas', () => {
    const cond = [{ field: 'a', operator: 'exists' as const }];
    const d = diagnose({ a: 1, c: 1 }, { b: 1 }, [
      map('a', 'b', { conditions: cond }),
      map('c', 'b', { conditions: cond }),
    ]);
    expect(d[0]).toMatchObject({ code: 'duplicate-mapping', severity: 'info' });
  });

  it('campo obrigatório não preenchido', () => {
    const d = diagnose({ a: 1 }, { b: 1, c: 1 }, [map('a', 'b')], { required: ['c'] });
    expect(d[0]).toMatchObject({ code: 'required-unfilled', field: 'c', severity: 'error' });
    expect(diagnose({ a: 1 }, { c: 1 }, [map('a', 'c')], { required: ['c'] })).toEqual([]);
  });

  it('obrigatório dentro de objeto opcional não preenchido é ignorado', () => {
    expect(
      diagnose({ a: 1 }, { o: { c: 1 }, b: 1 }, [map('a', 'b')], { required: ['o.c'] }),
    ).toEqual([]);
  });

  it('transformações inválidas', () => {
    const d = diagnose({ a: 1 }, { b: 1 }, [map('a', 'b', { transforms: [step('inexistente')] })]);
    expect(codes(d)).toEqual(['transform-invalid']);
    const e = diagnose({ a: 1 }, { b: 1 }, [
      map('a', 'b', { transforms: [step('divide', { operand: 0 })] }),
    ]);
    expect(codes(e)).toContain('transform-invalid');
    const f = diagnose({ a: 1 }, { b: 1 }, [map('a', 'b', { transforms: [step('sum')] })]);
    expect(f[0]).toMatchObject({ code: 'transform-invalid', severity: 'error' });
  });

  it('etapa desabilitada não gera diagnóstico', () => {
    const d = diagnose({ a: 1 }, { b: 1 }, [
      map('a', 'b', { transforms: [{ ...step('inexistente'), disabled: true }] }),
    ]);
    expect(d).toEqual([]);
  });

  it('referências circulares entre mapeamentos', () => {
    const d = diagnose({ a: 1, b: 1 }, { a: 1, b: 1 }, [map('a', 'b'), map('b', 'a')]);
    expect(codes(d)).toContain('circular-reference');
    expect(d.find((x) => x.code === 'circular-reference')?.message).toContain('→');
  });

  it('referência circular no DTO Java', () => {
    const d = runDiagnostics({
      mappings: [],
      source: parseJavaStructure('class No { No prox; }'),
      target: json({}),
    });
    expect(codes(d)).toEqual(['circular-reference']);
  });

  it('conflitos de caminhos', () => {
    const d = diagnose({ a: 1, c: { x: 1 } }, { b: { x: 1 } }, [map('c', 'b'), map('a', 'b.x')]);
    expect(codes(d)).toContain('path-conflict');
  });

  it('arrays incompatíveis', () => {
    const src = { l: [{ v: 1 }], m: [{ v: 1 }], n: 1 };
    expect(codes(diagnose(src, { t: 1 }, [map('l[*].v', 't')]))).toEqual(['array-incompatible']);
    expect(diagnose(src, { t: 1 }, [map('l[*].v', 't', { transforms: [step('sum')] })])).toEqual(
      [],
    );
    expect(codes(diagnose(src, { t: 1 }, [map('l', 't')]))).toContain('array-incompatible');
    expect(
      diagnose(src, { t: [{ a: 1 }] }, [map('n', 't[*].a'), map('l[*].v', 't[*].a')]).some(
        (d) => d.severity === 'info',
      ),
    ).toBe(true);
    const mixed = diagnose(src, { t: [{ a: 1, b: 1 }] }, [
      map('l[*].v', 't[*].a'),
      map('m[*].v', 't[*].b'),
    ]);
    expect(mixed[0]).toMatchObject({ code: 'array-incompatible', severity: 'error' });
    expect(mixed[0].message).toContain('misturados');
  });

  it('valores nulos inesperados', () => {
    const d = diagnose({ a: null }, { b: 'x' }, [map('a', 'b')], {
      required: ['b'],
      data: { a: null },
    });
    expect(codes(d)).toEqual(['unexpected-null']);
    expect(
      diagnose({ a: null }, { b: 'x' }, [map('a', 'b', { defaultValue: 'd' })], {
        required: ['b'],
        data: { a: null },
      }),
    ).toEqual([]);
    const list = diagnose({ l: [{ a: 'x' }] }, { o: [{ b: 'x' }] }, [map('l[*].a', 'o[*].b')], {
      required: ['o[*].b'],
      data: { l: [{ a: 'x' }, { a: null }] },
    });
    expect(codes(list)).toEqual(['unexpected-null']);
  });

  it('escopos com campo inexistente ou sem uso', () => {
    const scope: ArrayScope = {
      id: 's',
      sourcePath: 'l[*]',
      targetPath: 'o[*]',
      sort: { field: 'z', direction: 'asc' },
    };
    const d = diagnose({ l: [{ a: 1 }] }, { o: [{ a: 1 }] }, [map('l[*].a', 'o[*].a')], {
      scopes: [scope],
    });
    expect(codes(d)).toEqual(['source-missing']);
    const unused = diagnose({ l: [{ a: 1 }] }, { o: [{ a: 1 }] }, [], {
      scopes: [{ id: 's', sourcePath: 'l[*]', targetPath: 'o[*]' }],
    });
    expect(unused[0].severity).toBe('info');
  });

  it('estrutura inválida e avisos de parser viram diagnósticos', () => {
    const d = runDiagnostics({
      mappings: [],
      source: json({ a: 1 }),
      target: parseStructure({
        format: 'java',
        text: 'class A { Foo f; }',
        rootName: 'A',
        overrides: {},
      }),
      sampleError: 'JSON inválido',
    });
    expect(codes(d).sort()).toEqual(['parser-notice', 'structure-invalid']);
  });

  it('ordena por gravidade e calcula o status do mapeamento', () => {
    const bad = map('x', 'b');
    const warn = map('a', 'c');
    const ok = map('d', 'e');
    const d = diagnose({ a: 'x', d: 1 }, { b: 1, c: 1, e: 1 }, [warn, bad, ok]);
    expect(d[0].severity).toBe('error');
    expect(statusFromDiagnostics(bad.id, d)).toBe('error');
    expect(statusFromDiagnostics(warn.id, d)).toBe('warning');
    expect(statusFromDiagnostics(ok.id, d)).toBe('valid');
  });
});
