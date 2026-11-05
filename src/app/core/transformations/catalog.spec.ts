import { JsonValue } from '../models/json.model';
import { TransformParams, TransformStep } from '../models/mapping.model';
import { runPipeline } from '../mapping-engine/pipeline';
import { flowStep, getTransform, TRANSFORMS, validateStep } from './catalog';
import { parseIsoDate, parseWithPattern, serializeDate } from './date-utils';
import { evaluate } from './values';

const run = (id: string, input: JsonValue | undefined, params: TransformParams = {}) => {
  const step: TransformStep = { id: 's', transformId: id, params };
  return runPipeline(input, [step]);
};
const value = (id: string, input: JsonValue | undefined, params: TransformParams = {}) =>
  run(id, input, params).value;

describe('catálogo', () => {
  it('cobre todas as transformações exigidas', () => {
    const ids = TRANSFORMS.map((t) => t.id);
    for (const id of [
      'uppercase',
      'lowercase',
      'trim',
      'capitalize',
      'replace',
      'substring',
      'split',
      'join',
      'concat',
      'removeAccents',
      'padStart',
      'padEnd',
      'stringToNumber',
      'numberToString',
      'round',
      'floor',
      'ceil',
      'abs',
      'multiply',
      'divide',
      'add',
      'subtract',
      'precision',
      'stringToDate',
      'dateToString',
      'toIso8601',
      'formatDate',
      'convertTimezone',
      'datePart',
      'isValidDate',
      'stringToBoolean',
      'numberToBoolean',
      'booleanToString',
      'defaultValue',
      'coalesce',
      'conditional',
      'constant',
      'lookup',
      'enumMap',
      'nullHandling',
      'removeEmpty',
      'filter',
      'map',
      'distinct',
      'sort',
      'count',
      'sum',
      'average',
      'min',
      'max',
      'first',
      'last',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(TRANSFORMS.map((t) => [t.id]))(
    '%s tem exemplo que executa sem erro e configuração válida',
    (id) => {
      const def = getTransform(id)!;
      const r = run(id, def.sample.input, def.sample.params);
      expect(r.errors).toEqual([]);
      expect(validateStep({ id: 's', transformId: id, params: def.sample.params })).toEqual([]);
    },
  );
});

describe('strings', () => {
  it.each<[string, JsonValue, TransformParams, JsonValue]>([
    ['uppercase', 'aé', {}, 'AÉ'],
    ['lowercase', 'AÉ', {}, 'aé'],
    ['trim', '  x ', {}, 'x'],
    ['capitalize', 'ana MARIA', {}, 'Ana Maria'],
    ['capitalize', 'ana MARIA', { allWords: false }, 'Ana maria'],
    ['replace', 'a.b.c', { search: '.', replacement: '-' }, 'a-b-c'],
    ['replace', 'a.b.c', { search: '.', replacement: '-', all: false }, 'a-b.c'],
    ['replace', 'a1b22', { search: '\\d+', replacement: '#', regex: true }, 'a#b#'],
    ['substring', 'abcdef', { start: 1, end: 3 }, 'bc'],
    ['substring', 'abcdef', { start: 4 }, 'ef'],
    ['split', 'a,b', { separator: ',' }, ['a', 'b']],
    ['join', ['a', null, 'b'], { separator: '-' }, 'a--b'],
    ['concat', 'x', { prefix: '<', suffix: '>' }, '<x>'],
    ['removeAccents', 'Ação ção é', {}, 'Acao cao e'],
    ['padStart', '7', { length: 3, char: '0' }, '007'],
    ['padEnd', '7', { length: 3, char: 'ab' }, '7ab'],
    ['uppercase', 12, {}, '12'],
  ])('%s(%j, %j)', (id, input, params, expected) => {
    expect(value(id, input, params)).toEqual(expected);
  });

  it('transformações escalares se aplicam a cada item da lista e preservam nulos', () => {
    expect(value('uppercase', ['a', null, 'b'])).toEqual(['A', null, 'B']);
    expect(value('uppercase', null)).toBeNull();
    expect(value('uppercase', undefined)).toBeUndefined();
  });

  it('valida expressão regular', () => {
    const errs = validateStep({
      id: 's',
      transformId: 'replace',
      params: { search: '(', regex: true },
    });
    expect(errs.join()).toContain('regular');
  });
});

describe('numbers', () => {
  it.each<[string, JsonValue, TransformParams, JsonValue]>([
    ['stringToNumber', '12.5', {}, 12.5],
    ['stringToNumber', '1.234,56', { decimalSeparator: ',' }, 1234.56],
    ['stringToNumber', 5, {}, 5],
    ['numberToString', 12.5, {}, '12.5'],
    ['numberToString', 12.5, { digits: 2 }, '12.50'],
    ['round', 2.345, { digits: 2 }, 2.35],
    ['round', 2.5, {}, 3],
    ['floor', 2.9, {}, 2],
    ['ceil', 2.1, {}, 3],
    ['abs', -2, {}, 2],
    ['multiply', 2, { operand: 3 }, 6],
    ['divide', 6, { operand: 3 }, 2],
    ['add', 2, { operand: 3 }, 5],
    ['subtract', 2, { operand: 3 }, -1],
    ['precision', 1.005, { digits: 1 }, 1],
    ['add', '2', { operand: 1 }, 3],
  ])('%s(%j, %j)', (id, input, params, expected) => {
    expect(value(id, input, params)).toEqual(expected);
  });

  it.each(['abc', '', '1,5', '12a'])('stringToNumber rejeita %j', (input) => {
    const r = run('stringToNumber', input);
    expect(r.value).toBeNull();
    expect(r.errors).toHaveLength(1);
  });

  it('não aceita booleano como número', () => {
    expect(run('add', true, { operand: 1 }).errors).toHaveLength(1);
  });

  it('divisão por zero é erro de configuração', () => {
    expect(validateStep({ id: 's', transformId: 'divide', params: { operand: 0 } })).toHaveLength(
      1,
    );
    expect(run('divide', 1, { operand: 0 }).errors).toHaveLength(1);
  });
});

describe('dates', () => {
  it.each<[string, JsonValue, TransformParams, JsonValue]>([
    ['stringToDate', '17/05/2024', { pattern: 'dd/MM/yyyy' }, '2024-05-17'],
    ['stringToDate', '2024-05-17T10:30', {}, '2024-05-17T10:30:00'],
    ['stringToDate', '17/05/2024 08:05', { pattern: 'dd/MM/yyyy HH:mm' }, '2024-05-17T08:05:00'],
    ['dateToString', '2024-05-17', { pattern: 'dd/MM/yyyy' }, '17/05/2024'],
    ['dateToString', '2024-05-17T08:05:09', { pattern: "yyyy'T'HH:mm:ss" }, '2024T08:05:09'],
    [
      'toIso8601',
      '2024-05-17T10:30:00',
      { timeZone: 'America/Sao_Paulo' },
      '2024-05-17T13:30:00.000Z',
    ],
    ['toIso8601', '2024-05-17T10:30:00+01:00', { timeZone: 'UTC' }, '2024-05-17T09:30:00.000Z'],
    ['toIso8601', '2024-05-17', {}, '2024-05-17T00:00:00.000Z'],
    ['formatDate', '20240517', { inputPattern: 'yyyyMMdd', pattern: 'dd/MM/yyyy' }, '17/05/2024'],
    [
      'convertTimezone',
      '2024-05-17T12:00:00Z',
      { to: 'America/Sao_Paulo' },
      '2024-05-17T09:00:00-03:00',
    ],
    [
      'convertTimezone',
      '2024-01-15T12:00:00',
      { from: 'America/New_York', to: 'UTC' },
      '2024-01-15T17:00:00Z',
    ],
    [
      'convertTimezone',
      '2024-07-15T12:00:00',
      { from: 'America/New_York', to: 'Asia/Tokyo' },
      '2024-07-16T01:00:00+09:00',
    ],
    ['datePart', '2024-05-17', { part: 'day' }, 17],
    ['datePart', '2024-05-17', { part: 'month' }, 5],
    ['datePart', '2024-05-17', { part: 'year' }, 2024],
    ['isValidDate', '2024-02-29', {}, true],
    ['isValidDate', '2023-02-29', {}, false],
    ['isValidDate', '31/04/2024', { pattern: 'dd/MM/yyyy' }, false],
  ])('%s(%j, %j)', (id, input, params, expected) => {
    expect(value(id, input, params)).toEqual(expected);
  });

  it('erros de data', () => {
    expect(run('stringToDate', 'ontem').errors).toHaveLength(1);
    expect(run('stringToDate', '32/01/2024', { pattern: 'dd/MM/yyyy' }).errors).toHaveLength(1);
    expect(
      validateStep({ id: 's', transformId: 'dateToString', params: { pattern: 'QQQ' } }),
    ).toHaveLength(1);
    expect(
      validateStep({ id: 's', transformId: 'convertTimezone', params: { to: 'Lua/Base' } }),
    ).toHaveLength(1);
  });

  it('não depende do fuso da máquina', () => {
    expect(serializeDate(parseIsoDate('2024-05-17T10:30:00')!)).toBe('2024-05-17T10:30:00');
    expect(parseWithPattern('2024-13-01', 'yyyy-MM-dd')).toBeNull();
  });
});

describe('boolean', () => {
  it.each<[string, JsonValue, TransformParams, JsonValue]>([
    ['stringToBoolean', 'Sim', {}, true],
    ['stringToBoolean', 'nao', {}, false],
    ['stringToBoolean', 'OK', { trueValues: 'ok', falseValues: 'ko' }, true],
    ['stringToBoolean', true, {}, true],
    ['numberToBoolean', 0, {}, false],
    ['numberToBoolean', 2, {}, true],
    ['booleanToString', true, { trueLabel: 'Ativo' }, 'Ativo'],
    ['booleanToString', false, {}, 'false'],
  ])('%s(%j, %j)', (id, input, params, expected) => {
    expect(value(id, input, params)).toEqual(expected);
  });

  it('valor fora das listas gera erro', () => {
    expect(run('stringToBoolean', 'talvez').errors).toHaveLength(1);
  });
});

describe('utilitários', () => {
  it('default value', () => {
    expect(value('defaultValue', null, { value: 'x' })).toBe('x');
    expect(value('defaultValue', undefined, { value: 'x' })).toBe('x');
    expect(value('defaultValue', 'a', { value: 'x' })).toBe('a');
    expect(value('defaultValue', '', { value: 'x' })).toBe('');
    expect(value('defaultValue', '', { value: 'x', emptyAsNull: true })).toBe('x');
  });

  it('coalesce usa o primeiro não nulo', () => {
    const lookup: Record<string, JsonValue> = { a: null, b: 'B' };
    const step: TransformStep = { id: 's', transformId: 'coalesce', params: { paths: ['a', 'b'] } };
    expect(runPipeline(null, [step], { resolve: (p) => lookup[p] }).value).toBe('B');
    expect(runPipeline('v', [step], { resolve: (p) => lookup[p] }).value).toBe('v');
  });

  it('conditional', () => {
    const params = { operator: 'gte', compare: 18, thenValue: 'adulto', elseValue: 'menor' };
    expect(value('conditional', 20, params)).toBe('adulto');
    expect(value('conditional', 10, params)).toBe('menor');
    expect(value('conditional', 10, { operator: 'eq', compare: 10, thenValue: 'dez' })).toBe('dez');
    expect(value('conditional', 11, { operator: 'eq', compare: 10, thenValue: 'dez' })).toBe(11);
  });

  it('constant', () => {
    expect(value('constant', 'x', { value: 1 })).toBe(1);
    expect(value('constant', undefined, { value: 'y' })).toBe('y');
  });

  it('lookup', () => {
    const table = { a: 'A' };
    expect(value('lookup', 'a', { table })).toBe('A');
    expect(value('lookup', 'b', { table })).toBeNull();
    expect(value('lookup', 'b', { table, fallback: '?' })).toBe('?');
    expect(value('lookup', 'b', { table, keepUnmatched: true })).toBe('b');
    expect(value('lookup', 'toString', { table })).toBeNull();
  });

  it('enum mapping', () => {
    const table = { a: 'A' };
    expect(value('enumMap', 'a', { table })).toBe('A');
    expect(run('enumMap', 'b', { table }).errors).toHaveLength(1);
    expect(value('enumMap', 'b', { table, strict: false })).toBe('b');
  });

  it('null handling', () => {
    expect(value('nullHandling', null, { mode: 'keep' })).toBeNull();
    expect(value('nullHandling', undefined, { mode: 'keep' })).toBeNull();
    expect(value('nullHandling', null, { mode: 'omit' })).toBeUndefined();
    expect(value('nullHandling', null, { mode: 'empty-string' })).toBe('');
    expect(value('nullHandling', null, { mode: 'zero' })).toBe(0);
    expect(value('nullHandling', null, { mode: 'false' })).toBe(false);
    expect(run('nullHandling', null, { mode: 'error' }).errors).toHaveLength(1);
    expect(value('nullHandling', 'x', { mode: 'zero' })).toBe('x');
  });

  it('remove empty', () => {
    expect(
      value('removeEmpty', {
        a: 1,
        b: null,
        c: '',
        d: [],
        e: {},
        f: { g: null },
        h: [1, '', null],
      }),
    ).toEqual({
      a: 1,
      h: [1],
    });
  });
});

describe('arrays', () => {
  const list = [
    { id: 1, s: 'b', v: 10 },
    { id: 2, s: 'a', v: null },
    { id: 3, s: 'b', v: 5 },
  ];

  it.each<[string, JsonValue, TransformParams, JsonValue]>([
    ['filter', list, { field: 's', operator: 'eq', value: 'a' }, [list[1]]],
    ['filter', [1, 5, 9], { operator: 'gt', value: 4 }, [5, 9]],
    ['filter', list, { field: 'v', operator: 'exists' }, [list[0], list[2]]],
    ['map', list, { field: 'id' }, [1, 2, 3]],
    ['distinct', [1, 1, '1', 2], {}, [1, '1', 2]],
    ['distinct', list, { field: 's' }, [list[0], list[1]]],
    ['sort', list, { field: 'v', direction: 'asc' }, [list[2], list[0], list[1]]],
    ['sort', list, { field: 'v', direction: 'desc' }, [list[0], list[2], list[1]]],
    ['sort', [10, 9, 100], {}, [9, 10, 100]],
    ['count', list, {}, 3],
    ['count', null, {}, 0],
    ['sum', [1, null, 2], {}, 3],
    ['sum', list, { field: 'v' }, 15],
    ['sum', [], {}, 0],
    ['average', [2, 4], {}, 3],
    ['average', [], {}, null],
    ['min', list, { field: 'v' }, 5],
    ['max', list, { field: 'v' }, 10],
    ['min', [], {}, null],
    ['first', [1, 2], {}, 1],
    ['last', [1, 2], {}, 2],
    ['first', [], {}, null],
  ])('%s(%j, %j)', (id, input, params, expected) => {
    expect(value(id, input, params)).toEqual(expected);
  });

  it('agregação em escalar é erro de conversão', () => {
    expect(run('sum', 5).errors).toHaveLength(1);
    expect(run('sum', ['x']).errors).toHaveLength(1);
  });
});

describe('condições e tipos', () => {
  it.each<[JsonValue | undefined, string, JsonValue | undefined, boolean]>([
    [1, 'eq', '1', true],
    ['a', 'ne', 'b', true],
    [null, 'eq', null, true],
    [10, 'gt', 9, true],
    ['10', 'gt', '9', true],
    [null, 'gt', 1, false],
    ['abc', 'contains', 'b', true],
    [['a', 'b'], 'contains', 'b', true],
    ['abc', 'startsWith', 'a', true],
    ['abc', 'endsWith', 'c', true],
    ['a', 'in', 'a, b', true],
    ['c', 'notIn', ['a', 'b'], true],
    [undefined, 'exists', undefined, false],
    [undefined, 'notExists', undefined, true],
    ['', 'empty', undefined, true],
    [[], 'notEmpty', undefined, false],
    ['a1', 'matches', '^a\\d$', true],
    ['a1', 'matches', '(', false],
  ])('%j %s %j', (v, op, cmp, expected) => {
    expect(evaluate(v, op as never, cmp)).toBe(expected);
  });

  it('propaga o tipo estático pelas etapas', () => {
    const steps: TransformStep[] = [
      { id: '1', transformId: 'split', params: { separator: ',' } },
      { id: '2', transformId: 'first', params: {} },
      { id: '3', transformId: 'stringToNumber', params: {} },
    ];
    expect(steps.reduce(flowStep, { type: 'string' })).toEqual({ type: 'number' });
    expect(
      flowStep({ type: 'array', itemType: 'number' }, { id: 'x', transformId: 'max', params: {} }),
    ).toEqual({
      type: 'number',
    });
    expect(
      flowStep(
        { type: 'array', itemType: 'string' },
        { id: 'x', transformId: 'uppercase', params: {} },
      ),
    ).toEqual({
      type: 'array',
      itemType: 'string',
    });
  });
});
