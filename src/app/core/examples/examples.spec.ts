import { executeMappings } from '../mapping-engine/engine';
import { JsonValue } from '../models/json.model';
import { parseStructure } from '../parsers/structure';
import { diagnoseDocument } from '../validators/diagnostics';
import { EXAMPLES } from './examples';

describe('galeria de exemplos', () => {
  it('tem os oito exemplos pedidos', () => {
    expect(EXAMPLES.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(EXAMPLES[4].document.source.format).toBe('java');
    expect(EXAMPLES[5].document.target.format).toBe('typescript');
  });

  it.each(EXAMPLES.map((e) => [e.title, e] as const))(
    '%s produz o resultado esperado',
    (_, example) => {
      const data = JSON.parse(example.document.sampleData) as JsonValue;
      const r = executeMappings({
        source: data,
        mappings: example.document.mappings,
        scopes: example.document.scopes,
      });
      expect(r.output).toEqual(example.expectedOutput);
      if (example.id !== 'erros') {
        expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
      }
    },
  );

  it.each(EXAMPLES.filter((e) => e.id !== 'erros').map((e) => [e.title, e] as const))(
    '%s não tem erros de diagnóstico',
    (_, example) => {
      const errors = diagnoseDocument(example.document).filter((d) => d.severity === 'error');
      expect(errors).toEqual([]);
      expect(
        parseStructure(example.document.source).issues.filter((i) => i.severity === 'error'),
      ).toEqual([]);
    },
  );

  it('o exemplo de erros produz todos os diagnósticos previstos', () => {
    const example = EXAMPLES.find((e) => e.id === 'erros')!;
    const codes = new Set(diagnoseDocument(example.document).map((d) => d.code));
    for (const code of example.expectedDiagnostics ?? []) expect(codes).toContain(code);
  });
});
