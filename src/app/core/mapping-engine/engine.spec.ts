import { JsonValue } from '../models/json.model';
import { ArrayScope, Mapping, TransformStep } from '../models/mapping.model';
import { executeMappings } from './engine';
import { getIn, parsePath, formatPath, setIn, cloneJson, PathSyntaxError } from './path';

let seq = 0;
const step = (transformId: string, params: TransformStep['params'] = {}): TransformStep => ({
  id: `s${++seq}`,
  transformId,
  params,
});
const map = (sourcePath: string, targetPath: string, extra: Partial<Mapping> = {}): Mapping => ({
  id: `m${++seq}`,
  sourcePath,
  targetPath,
  sourceType: 'any',
  targetType: 'any',
  transforms: [],
  validationStatus: 'unknown',
  ...extra,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('caminhos', () => {
  it('interpreta propriedades, wildcards, índices e chaves entre aspas', () => {
    expect(parsePath('a.b[*].c[0]')).toEqual([
      { kind: 'prop', name: 'a' },
      { kind: 'prop', name: 'b' },
      { kind: 'wildcard' },
      { kind: 'prop', name: 'c' },
      { kind: 'index', index: 0 },
    ]);
    expect(parsePath('a["x.y z"].b')[1]).toEqual({ kind: 'prop', name: 'x.y z' });
    expect(formatPath(parsePath('a["x.y z"].b[*]'))).toBe('a["x.y z"].b[*]');
  });

  it.each([
    'a..b',
    '.a',
    'a.',
    'a[',
    'a[x]',
    'a[*',
    '__proto__.x',
    'a.constructor',
    'a.prototype.b',
  ])('rejeita "%s"', (p) => {
    expect(() => parsePath(p)).toThrow(PathSyntaxError);
  });

  it('lê caminhos aninhados e devolve undefined quando não existem', () => {
    const data: JsonValue = { a: { b: [{ c: 1 }, { c: 2 }, {}] }, n: null };
    expect(getIn(data, 'a.b[1].c')).toBe(2);
    expect(getIn(data, 'a.b[*].c')).toEqual([1, 2, null]);
    expect(getIn(data, 'a.x.y')).toBeUndefined();
    expect(getIn(data, 'n')).toBeNull();
    expect(getIn(data, 'n.x')).toBeUndefined();
    expect(getIn(data, 'a.toString')).toBeUndefined();
  });

  it('setIn não altera a entrada e compartilha ramos intocados', () => {
    const data = deepFreeze({ a: { b: 1 }, keep: { x: 1 } }) as unknown as JsonValue;
    const next = setIn(data, 'a.c.d', 9) as { a: { c: { d: number } }; keep: unknown };
    expect(next.a.c.d).toBe(9);
    expect(next.keep).toBe((data as { keep: unknown }).keep);
    expect(data).toEqual({ a: { b: 1 }, keep: { x: 1 } });
  });

  it('cloneJson descarta a chave __proto__ vinda de JSON.parse', () => {
    const copy = cloneJson(JSON.parse('{"__proto__":{"x":1},"y":2}'));
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(Object.keys(copy as object)).toEqual(['y']);
  });
});

describe('motor de mapeamento', () => {
  it('mapeia objetos aninhados sem modificar a origem', () => {
    const source = deepFreeze({ cliente: { nomeCompleto: 'Ana', meta: { a: 1 } } });
    const r = executeMappings({
      source,
      mappings: [
        map('cliente.nomeCompleto', 'customer.fullName'),
        map('cliente.meta', 'customer.meta'),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ customer: { fullName: 'Ana', meta: { a: 1 } } });
    (r.output as { customer: { meta: { a: number } } }).customer.meta.a = 2;
    expect(source.cliente.meta.a).toBe(1);
  });

  it('distingue nulo (escreve null) de ausente (não escreve)', () => {
    const r = executeMappings({
      source: { a: null },
      mappings: [map('a', 'x'), map('b', 'y')],
    });
    expect(r.output).toEqual({ x: null });
    expect(r.ignored.map((i) => i.path)).toEqual(['y']);
    expect(r.stats.mappedFields).toBe(1);
  });

  it('aplica valor padrão para nulo e ausente', () => {
    const r = executeMappings({
      source: { a: null },
      mappings: [map('a', 'x', { defaultValue: 'd1' }), map('b', 'y', { defaultValue: 0 })],
    });
    expect(r.output).toEqual({ x: 'd1', y: 0 });
  });

  it('encadeia transformações e registra o trace de cada etapa', () => {
    const m = map('nome', 'name', {
      transforms: [step('trim'), step('uppercase'), step('padEnd', { length: 5, char: '.' })],
    });
    const r = executeMappings({ source: { nome: '  ana ' }, mappings: [m] });
    expect(r.output).toEqual({ name: 'ANA..' });
    expect(r.traces[m.id].map((t) => [t.input, t.output])).toEqual([
      ['  ana ', 'ana'],
      ['ana', 'ANA'],
      ['ANA', 'ANA..'],
    ]);
    expect(r.stats.transformations).toBe(3);
  });

  it('ignora etapas desabilitadas', () => {
    const r = executeMappings({
      source: { a: 'x' },
      mappings: [map('a', 'b', { transforms: [{ ...step('uppercase'), disabled: true }] })],
    });
    expect(r.output).toEqual({ b: 'x' });
    expect(r.stats.transformations).toBe(0);
  });

  it('registra erro de conversão, escreve null e segue com os demais', () => {
    const r = executeMappings({
      source: { a: 'abc', b: '12' },
      mappings: [
        map('a', 'x', { transforms: [step('stringToNumber')] }),
        map('b', 'y', { transforms: [step('stringToNumber')] }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.output).toEqual({ x: null, y: 12 });
    expect(r.stats.conversionErrors).toBe(1);
  });

  it('valida antes de executar: mapeamento inválido é ignorado', () => {
    const r = executeMappings({
      source: { a: 1 },
      mappings: [
        map('a..b', 'x'),
        map('a', 'list[0].x'),
        map('a', 'y', { transforms: [step('naoExiste')] }),
        map('a', 'z', { transforms: [step('divide', { operand: 0 })] }),
        map('a', 'ok'),
      ],
    });
    expect(r.output).toEqual({ ok: 1 });
    expect(r.issues.filter((i) => i.kind === 'validation')).toHaveLength(4);
  });

  it('avalia condições', () => {
    const r = executeMappings({
      source: { valor: 10, tipo: 'A' },
      mappings: [
        map('valor', 'sim', { conditions: [{ field: 'tipo', operator: 'eq', value: 'A' }] }),
        map('valor', 'nao', { conditions: [{ field: 'tipo', operator: 'eq', value: 'B' }] }),
      ],
    });
    expect(r.output).toEqual({ sim: 10 });
  });

  it('não permite poluição de protótipo por caminho', () => {
    const r = executeMappings({ source: { a: 1 }, mappings: [map('a', '__proto__.polluted')] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('informa conflito de caminhos sem sobrescrever', () => {
    const r = executeMappings({
      source: { a: 1, b: 2 },
      mappings: [map('a', 'x'), map('b', 'x.y')],
    });
    expect(r.output).toEqual({ x: 1 });
    expect(r.issues.some((i) => i.kind === 'conflict')).toBe(true);
  });
});

describe('arrays', () => {
  const source = {
    moeda: 'BRL',
    pedidos: [
      {
        codigo: 101,
        valor: 150.5,
        status: 'A',
        itens: [
          { q: 1, sku: 'x' },
          { q: 2, sku: 'y' },
        ],
      },
      { codigo: 102, valor: 250, status: 'B', itens: [] },
      { codigo: 103, valor: 50, status: 'A', itens: [{ q: 5, sku: 'x' }] },
    ],
  };

  it('itera por item e mantém os campos da mesma posição', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].codigo', 'orders[*].id'),
        map('pedidos[*].valor', 'orders[*].amount'),
      ],
    });
    expect(r.output).toEqual({
      orders: [
        { id: 101, amount: 150.5 },
        { id: 102, amount: 250 },
        { id: 103, amount: 50 },
      ],
    });
  });

  it('mapeia arrays aninhados sem misturar pais', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].codigo', 'o[*].id'),
        map('pedidos[*].itens[*].sku', 'o[*].items[*].code'),
      ],
    });
    expect(r.output).toEqual({
      o: [
        { id: 101, items: [{ code: 'x' }, { code: 'y' }] },
        { id: 102, items: [] },
        { id: 103, items: [{ code: 'x' }] },
      ],
    });
  });

  it('mapeia lista de primitivos e matriz', () => {
    const r = executeMappings({
      source: { tags: ['a', 'b'], m: [[1, 2], [3]] },
      mappings: [
        map('tags[*]', 'labels[*]', { transforms: [step('uppercase')] }),
        map('m[*][*]', 'grid[*][*]'),
      ],
    });
    expect(r.output).toEqual({ labels: ['A', 'B'], grid: [[1, 2], [3]] });
  });

  it('agrega com coleta e preserva o contexto por linha', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].valor', 'total', { transforms: [step('sum')] }),
        map('pedidos[*].codigo', 'orders[*].id'),
        map('pedidos[*].itens[*].q', 'orders[*].qty', { transforms: [step('sum')] }),
      ],
    });
    expect(r.output).toEqual({
      total: 450.5,
      orders: [
        { id: 101, qty: 3 },
        { id: 102, qty: 0 },
        { id: 103, qty: 5 },
      ],
    });
  });

  it.each([
    ['count', [], 3],
    ['average', [], 450.5 / 3],
    ['min', [], 50],
    ['max', [], 250],
    ['first', [], 150.5],
    ['last', [], 50],
  ] as const)('agregação %s', (id, _, expected) => {
    const r = executeMappings({
      source,
      mappings: [map('pedidos[*].valor', 'r', { transforms: [step(id)] })],
    });
    expect(r.output).toEqual({ r: expected });
  });

  it('encadeia filter, map, distinct e sort sobre a lista', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos', 'ids', {
          transforms: [
            step('filter', { field: 'status', operator: 'eq', value: 'A' }),
            step('sort', { field: 'valor', direction: 'asc' }),
            step('map', { field: 'codigo' }),
          ],
        }),
        map('pedidos[*].status', 'statuses', { transforms: [step('distinct')] }),
      ],
    });
    expect(r.output).toEqual({ ids: [103, 101], statuses: ['A', 'B'] });
  });

  it('escopo com filtro e ordenação mantém os campos de uma linha alinhados', () => {
    const scope: ArrayScope = {
      id: 's',
      sourcePath: 'pedidos[*]',
      targetPath: 'o[*]',
      filter: [{ field: 'status', operator: 'eq', value: 'A' }],
      sort: { field: 'valor', direction: 'asc' },
    };
    const r = executeMappings({
      source,
      scopes: [scope],
      mappings: [map('pedidos[*].codigo', 'o[*].id'), map('pedidos[*].valor', 'o[*].v')],
    });
    expect(r.output).toEqual({
      o: [
        { id: 103, v: 50 },
        { id: 101, v: 150.5 },
      ],
    });
  });

  it('escopo com distinct', () => {
    const r = executeMappings({
      source,
      scopes: [{ id: 's', sourcePath: 'pedidos[*]', targetPath: 'o[*]', distinctBy: 'status' }],
      mappings: [map('pedidos[*].codigo', 'o[*].id')],
    });
    expect(r.output).toEqual({ o: [{ id: 101 }, { id: 102 }] });
  });

  it('filtro que elimina tudo gera array vazio', () => {
    const r = executeMappings({
      source,
      scopes: [
        {
          id: 's',
          sourcePath: 'pedidos[*]',
          targetPath: 'o[*]',
          filter: [{ field: 'status', operator: 'eq', value: 'Z' }],
        },
      ],
      mappings: [map('pedidos[*].codigo', 'o[*].id')],
    });
    expect(r.output).toEqual({ o: [] });
  });

  it('copia valor do contexto pai para linhas existentes, em qualquer ordem declarada', () => {
    const r = executeMappings({
      source,
      mappings: [map('moeda', 'o[*].currency'), map('pedidos[*].codigo', 'o[*].id')],
    });
    expect(r.output).toEqual({
      o: [
        { id: 101, currency: 'BRL' },
        { id: 102, currency: 'BRL' },
        { id: 103, currency: 'BRL' },
      ],
    });
  });

  it('copia do item pai para o array filho', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].itens[*].sku', 'o[*].i[*].sku'),
        map('pedidos[*].codigo', 'o[*].i[*].pedido'),
      ],
    });
    expect(r.output).toEqual({
      o: [
        {
          i: [
            { sku: 'x', pedido: 101 },
            { sku: 'y', pedido: 101 },
          ],
        },
        { i: [] },
        { i: [{ sku: 'x', pedido: 103 }] },
      ],
    });
  });

  it('avisa quando não há linhas para receber o valor', () => {
    const r = executeMappings({ source, mappings: [map('moeda', 'o[*].currency')] });
    expect(r.output).toEqual({});
    expect(r.issues.some((i) => i.kind === 'missing' && i.severity === 'warning')).toBe(true);
  });

  it('condição com [*] lê o item corrente, inclusive na coleta', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].codigo', 'o[*].id'),
        map('pedidos[*].valor', 'o[*].v', {
          conditions: [{ field: 'pedidos[*].status', operator: 'eq', value: 'A' }],
        }),
        map('pedidos[*].valor', 'somaA', {
          conditions: [{ field: 'pedidos[*].status', operator: 'eq', value: 'A' }],
          transforms: [step('sum')],
        }),
      ],
    });
    expect(r.output).toEqual({
      o: [{ id: 101, v: 150.5 }, { id: 102 }, { id: 103, v: 50 }],
      somaA: 200.5,
    });
  });

  it('concat lê outro campo do mesmo item', () => {
    const r = executeMappings({
      source,
      mappings: [
        map('pedidos[*].codigo', 'o[*].label', {
          transforms: [step('concat', { fields: ['pedidos[*].status'], separator: '-' })],
        }),
      ],
    });
    expect(r.output).toEqual({ o: [{ label: '101-A' }, { label: '102-B' }, { label: '103-A' }] });
  });

  it('array ausente não escreve; array vazio escreve vazio', () => {
    const r = executeMappings({
      source: { vazio: [] },
      mappings: [map('vazio[*].a', 'x[*].a'), map('ausente[*].a', 'y[*].a')],
    });
    expect(r.output).toEqual({ x: [] });
    expect(r.ignored.map((i) => i.path)).toEqual(['y[*].a']);
  });

  it('não confunde escalar com array', () => {
    const r = executeMappings({ source: { a: 1 }, mappings: [map('a[*].b', 'x[*].b')] });
    expect(r.output).toEqual({});
    expect(r.issues.some((i) => i.kind === 'conflict')).toBe(true);
  });

  it('array na raiz', () => {
    const r = executeMappings({
      source: [{ a: 1 }, { a: 2 }],
      mappings: [map('[*].a', '[*].b')],
    });
    expect(r.output).toEqual([{ b: 1 }, { b: 2 }]);
  });

  it('mapeamento sem origem usa constante', () => {
    const r = executeMappings({
      source,
      mappings: [map('', 'versao', { transforms: [step('constant', { value: 2 })] })],
    });
    expect(r.output).toEqual({ versao: 2 });
  });
});
