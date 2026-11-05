import { inferSchema } from '../parsers/json-parser';
import { levenshtein, splitWords, suggestMappings } from './smart-mapping';

const suggest = (source: object, target: object, opts = {}) =>
  suggestMappings(inferSchema(source as never), inferSchema(target as never), opts);

describe('palavras', () => {
  it.each([
    ['nomeCompleto', ['nome', 'completo']],
    ['nome_completo', ['nome', 'completo']],
    ['nome-completo', ['nome', 'completo']],
    ['NOME_COMPLETO', ['nome', 'completo']],
    ['HTTPStatus', ['http', 'status']],
    ['endereço', ['endereco']],
  ])('%s', (input, expected) => {
    expect(splitWords(input)).toEqual(expected);
  });

  it('levenshtein', () => {
    expect(levenshtein('casa', 'caso')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('Smart Mapping', () => {
  it('nomes exatos têm confiança alta', () => {
    const [s] = suggest({ id: 1 }, { id: 2 });
    expect(s).toMatchObject({
      sourcePath: 'id',
      targetPath: 'id',
      level: 'high',
      ambiguous: false,
    });
    expect(s.reasons[0]).toContain('idênticos');
  });

  it.each([
    ['nomeCompleto', 'nome_completo', 'x', 'y'],
    ['nomeCompleto', 'NOME-COMPLETO', 'x', 'y'],
    ['firstName', 'FIRSTNAME', 'x', 'y'],
  ])('normaliza %s e %s', (a, b, va, vb) => {
    const [s] = suggest({ [a]: va }, { [b]: vb });
    expect(s.level).toBe('high');
    expect(s.reasons[0]).toContain('normalizar');
  });

  it.each([
    ['nomeCompleto', 'Ana', 'fullName', 'x', 'high'],
    ['dataNascimento', '2000-01-01', 'birthDate', '2001-01-01', 'high'],
    ['valorTotal', 1.5, 'totalAmount', 2.5, 'high'],
    ['ativo', true, 'enabled', false, 'high'],
  ] as const)('reconhece equivalência PT/EN: %s → %s', (a, va, b, vb, level) => {
    const [s] = suggest({ [a]: va }, { [b]: vb });
    expect(s).toMatchObject({ sourcePath: a, targetPath: b, level });
    expect(s.reasons.join(' ')).toMatch(/sinônimo/);
  });

  it('codigoCliente → customerId é sugestão de baixa confiança', () => {
    const [s] = suggest({ codigoCliente: 1 }, { customerId: 2 });
    expect(s).toMatchObject({
      sourcePath: 'codigoCliente',
      targetPath: 'customerId',
      level: 'low',
    });
    expect(s.reasons[0]).toContain('confirmação');
  });

  it('não sugere tipos incompatíveis', () => {
    expect(suggest({ nome: { a: 1 } }, { name: true })).toEqual([]);
    expect(suggest({ ativo: { a: 1 } }, { enabled: true })).toEqual([]);
  });

  it('reduz a confiança quando há conversão de tipo', () => {
    const [s] = suggest({ valor: '10' }, { amount: 10 });
    expect(s.level).toBe('medium');
    expect(s.reasons.join(' ')).toContain('conversão');
  });

  it('usa o caminho hierárquico para desempatar', () => {
    const r = suggest(
      { cliente: { nome: 'a' }, empresa: { nome: 'b' } },
      { customer: { name: 'x' }, company: { name: 'y' } },
    );
    expect(r.map((s) => [s.sourcePath, s.targetPath]).sort()).toEqual([
      ['cliente.nome', 'customer.name'],
      ['empresa.nome', 'company.name'],
    ]);
    expect(r.every((s) => !s.ambiguous)).toBe(true);
  });

  it('marca ambiguidade e nunca a deixa em confiança alta', () => {
    const r = suggest({ a: { nome: 'x' }, b: { nome: 'y' } }, { name: 'z' });
    expect(r).toHaveLength(1);
    expect(r[0].ambiguous).toBe(true);
    expect(r[0].level).not.toBe('high');
    expect(r[0].alternatives).toHaveLength(1);
  });

  it('entende níveis de array', () => {
    const r = suggest(
      { pedidos: [{ codigo: 1, valor: 1.5 }] },
      { orders: [{ code: 1, amount: 1.5 }] },
    );
    expect(r.map((s) => s.targetPath).sort()).toEqual(['orders[*].amount', 'orders[*].code']);
    expect(r.every((s) => s.level === 'high')).toBe(true);
  });

  it('níveis de array diferentes têm baixa confiança', () => {
    const [s] = suggest({ pedidos: [{ valor: 1.5 }] }, { amount: 1.5 });
    expect(s.level).toBe('low');
  });

  it('aceita sinônimos configuráveis', () => {
    expect(suggest({ apelido: 'a' }, { nickname: 'b' })).toEqual([]);
    const [s] = suggest(
      { apelido: 'a' },
      { nickname: 'b' },
      {
        synonyms: [{ terms: ['apelido', 'nickname'] }],
      },
    );
    expect(s.level).toBe('high');
  });

  it('não repete campos já mapeados', () => {
    const r = suggest(
      { a: 1, b: 1 },
      { a: 1, b: 1 },
      {
        existing: [
          {
            id: 'm',
            sourcePath: 'a',
            targetPath: 'a',
            sourceType: 'integer',
            targetType: 'integer',
            transforms: [],
            validationStatus: 'valid',
          },
        ],
      },
    );
    expect(r.map((s) => s.targetPath)).toEqual(['b']);
  });

  it('é determinístico', () => {
    const src = { nome: 'a', valor: 1, data: '2020-01-01', ativo: true };
    const tgt = { name: 'a', value: 1, date: '2020-01-01', active: true };
    expect(suggest(src, tgt)).toEqual(suggest(src, tgt));
  });
});
