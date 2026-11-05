import { JsonValue } from '../models/json.model';
import { ConditionOperator, TransformParams, TransformStep } from '../models/mapping.model';
import { FieldType } from '../models/schema.model';
import { getIn, isObject, isValidPath, ownProp } from '../mapping-engine/path';
import {
  formatWithPattern,
  instantToZone,
  isValidPattern,
  isValidTimeZone,
  parseIsoDate,
  parseWithPattern,
  serializeDate,
  toEpochMillis,
  DateParts,
} from './date-utils';
import {
  compareValues,
  evaluate,
  isEmptyValue,
  isNil,
  OPERATORS,
  requireNumber,
  toText,
  TransformError,
  Value,
} from './values';

export type TransformCategory = 'string' | 'number' | 'date' | 'boolean' | 'utility' | 'array';

export type ParamType =
  'string' | 'number' | 'boolean' | 'select' | 'table' | 'list' | 'path' | 'pathList' | 'literal';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: JsonValue;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
}

export interface TransformContext {
  /** Resolve outro campo de origem, vinculado à linha corrente. */
  resolve(path: string): Value;
}

export interface TransformDefinition {
  id: string;
  label: string;
  category: TransformCategory;
  description: string;
  params: ParamDef[];
  /**
   * `scalar`: aplicada a cada elemento quando o valor é um array.
   * `array`: recebe a lista inteira.
   * `any`: recebe o valor como está.
   */
  kind: 'scalar' | 'array' | 'any';
  /** Quando verdadeiro, também executa com valor nulo ou ausente. */
  handlesNull?: boolean;
  /** Tipos aceitos na entrada estática. */
  accepts: FieldType[] | 'any';
  output: FieldType | 'same' | 'item' | ((input: FieldType, params: TransformParams) => FieldType);
  /** Tipo do elemento produzido pelas transformações que devolvem listas. */
  outputItem?: FieldType | 'same';
  validate?: (params: TransformParams) => string | null;
  apply: (value: Value, params: TransformParams, ctx: TransformContext) => Value;
  sample: { input: JsonValue; params: TransformParams };
}

const TEXT_INPUTS: FieldType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'date',
  'datetime',
  'any',
];
const NUM_INPUTS: FieldType[] = ['number', 'integer', 'string', 'any'];
const DATE_INPUTS: FieldType[] = ['string', 'date', 'datetime', 'any'];
const SCALAR_INPUTS: FieldType[] = [...TEXT_INPUTS, 'null'];

const pStr = (p: TransformParams, key: string, fallback = ''): string => {
  const v = p[key];
  return isNil(v) ? fallback : toText(v);
};
const pNum = (p: TransformParams, key: string, fallback = 0): number => {
  const v = p[key];
  return typeof v === 'number' ? v : isNil(v) || v === '' ? fallback : Number(v);
};
const pBool = (p: TransformParams, key: string, fallback = false): boolean => {
  const v = p[key];
  return typeof v === 'boolean' ? v : fallback;
};
export const pList = (p: TransformParams, key: string): string[] => {
  const v = p[key];
  if (Array.isArray(v)) return v.map((x) => toText(x));
  if (isNil(v) || v === '') return [];
  return toText(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
};
const pTable = (p: TransformParams, key: string): { [k: string]: JsonValue } => {
  const v = p[key];
  return isObject(v) ? v : {};
};

function asArray(v: Value, label: string): JsonValue[] {
  if (!Array.isArray(v)) throw new TransformError(`${label}: a entrada deve ser uma lista.`);
  return v;
}

function readDate(v: Value, pattern: string, label: string): DateParts {
  const text = toText(v);
  const parts = pattern ? parseWithPattern(text, pattern) : parseIsoDate(text);
  if (!parts) {
    throw new TransformError(
      `${label}: "${text}" não é uma data válida${pattern ? ` no padrão ${pattern}` : ''}.`,
    );
  }
  return parts;
}

function jsRound(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

const fieldOf = (el: Value, field: string): Value => (field === '' ? el : getIn(el, field));

function removeEmpty(v: Value): Value {
  if (Array.isArray(v)) {
    return v.map((x) => removeEmpty(x)).filter((x) => !isEmptyValue(x)) as JsonValue[];
  }
  if (isObject(v)) {
    const out: { [k: string]: JsonValue } = {};
    for (const key of Object.keys(v)) {
      const cleaned = removeEmpty(v[key]);
      if (!isEmptyValue(cleaned)) out[key] = cleaned as JsonValue;
    }
    return out;
  }
  return v;
}

function validateRegex(p: TransformParams): string | null {
  if (!pBool(p, 'regex')) return null;
  try {
    new RegExp(pStr(p, 'search'));
    return null;
  } catch {
    return 'Expressão regular inválida.';
  }
}

const OPERATOR_OPTIONS = OPERATORS.map((o) => ({ value: o.id, label: o.label }));
const PATTERN_HELP = "Tokens: yyyy MM dd HH mm ss SSS XXX. Literais entre aspas simples, como 'T'.";
const SORT_OPTIONS = [
  { value: 'asc', label: 'Crescente' },
  { value: 'desc', label: 'Decrescente' },
];

export const TRANSFORMS: TransformDefinition[] = [
  // ---------------------------------------------------------------- Strings
  {
    id: 'uppercase',
    label: 'Uppercase',
    category: 'string',
    description: 'Converte o texto para maiúsculas.',
    params: [],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v) => toText(v).toUpperCase(),
    sample: { input: 'mapforge', params: {} },
  },
  {
    id: 'lowercase',
    label: 'Lowercase',
    category: 'string',
    description: 'Converte o texto para minúsculas.',
    params: [],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v) => toText(v).toLowerCase(),
    sample: { input: 'MapForge', params: {} },
  },
  {
    id: 'trim',
    label: 'Trim',
    category: 'string',
    description: 'Remove espaços do início e do fim.',
    params: [],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v) => toText(v).trim(),
    sample: { input: '   Ana Maria  ', params: {} },
  },
  {
    id: 'capitalize',
    label: 'Capitalize',
    category: 'string',
    description:
      'Primeira letra maiúscula e as demais minúsculas, por palavra ou no texto inteiro.',
    params: [{ key: 'allWords', label: 'Todas as palavras', type: 'boolean', default: true }],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v, p) => {
      const lower = toText(v).toLowerCase();
      if (!pBool(p, 'allWords', true)) return lower.charAt(0).toUpperCase() + lower.slice(1);
      let out = '';
      let start = true;
      for (const ch of lower) {
        out += start ? ch.toUpperCase() : ch;
        start = /\s/.test(ch);
      }
      return out;
    },
    sample: { input: 'ana MARIA silva', params: { allWords: true } },
  },
  {
    id: 'replace',
    label: 'Replace',
    category: 'string',
    description: 'Substitui um trecho por outro. Aceita texto literal ou expressão regular.',
    params: [
      { key: 'search', label: 'Procurar', type: 'string', required: true },
      { key: 'replacement', label: 'Substituir por', type: 'string', default: '' },
      { key: 'regex', label: 'Expressão regular', type: 'boolean', default: false },
      { key: 'all', label: 'Todas as ocorrências', type: 'boolean', default: true },
    ],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    validate: validateRegex,
    apply: (v, p) => {
      const text = toText(v);
      const search = pStr(p, 'search');
      const replacement = pStr(p, 'replacement');
      const all = pBool(p, 'all', true);
      if (pBool(p, 'regex')) return text.replace(new RegExp(search, all ? 'g' : ''), replacement);
      if (search === '') return text;
      if (all) return text.split(search).join(replacement);
      const at = text.indexOf(search);
      return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + search.length);
    },
    sample: { input: '123.456.789-00', params: { search: '.', replacement: '', all: true } },
  },
  {
    id: 'substring',
    label: 'Substring',
    category: 'string',
    description: 'Extrai um trecho do texto pelas posições inicial e final (exclusiva).',
    params: [
      { key: 'start', label: 'Início', type: 'number', required: true, default: 0 },
      { key: 'end', label: 'Fim', type: 'number', help: 'Vazio vai até o final do texto.' },
    ],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v, p) => {
      const text = toText(v);
      const end = p['end'];
      return isNil(end) || end === ''
        ? text.substring(pNum(p, 'start'))
        : text.substring(pNum(p, 'start'), pNum(p, 'end'));
    },
    sample: { input: '2024-05-17', params: { start: 0, end: 4 } },
  },
  {
    id: 'split',
    label: 'Split',
    category: 'string',
    description: 'Divide o texto em uma lista usando um separador literal.',
    params: [
      { key: 'separator', label: 'Separador', type: 'string', required: true, default: ',' },
    ],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'array',
    outputItem: 'string',
    apply: (v, p) => toText(v).split(pStr(p, 'separator', ',')),
    sample: { input: 'a,b,c', params: { separator: ',' } },
  },
  {
    id: 'join',
    label: 'Join',
    category: 'string',
    description: 'Une os itens de uma lista em um único texto.',
    params: [{ key: 'separator', label: 'Separador', type: 'string', default: ', ' }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'string',
    apply: (v, p) =>
      asArray(v, 'Join')
        .map((x) => toText(x))
        .join(pStr(p, 'separator', ', ')),
    sample: { input: ['a', 'b', 'c'], params: { separator: ' / ' } },
  },
  {
    id: 'concat',
    label: 'Concat',
    category: 'string',
    description: 'Concatena o valor com prefixo, sufixo e outros campos da mesma linha.',
    params: [
      { key: 'prefix', label: 'Prefixo', type: 'string', default: '' },
      { key: 'suffix', label: 'Sufixo', type: 'string', default: '' },
      {
        key: 'fields',
        label: 'Outros campos',
        type: 'pathList',
        help: 'Caminhos de origem separados por vírgula.',
      },
      { key: 'separator', label: 'Separador entre campos', type: 'string', default: '' },
    ],
    kind: 'scalar',
    handlesNull: true,
    accepts: SCALAR_INPUTS,
    output: 'string',
    validate: (p) =>
      pList(p, 'fields').every(isValidPath) ? null : 'Caminho inválido em "Outros campos".',
    apply: (v, p, ctx) => {
      const parts = [v, ...pList(p, 'fields').map((f) => ctx.resolve(f))]
        .filter((x) => !isNil(x))
        .map((x) => toText(x));
      if (parts.length === 0 && !pStr(p, 'prefix') && !pStr(p, 'suffix')) return v;
      return pStr(p, 'prefix') + parts.join(pStr(p, 'separator')) + pStr(p, 'suffix');
    },
    sample: { input: 'Ana', params: { prefix: 'Sra. ', suffix: '!' } },
  },
  {
    id: 'removeAccents',
    label: 'Remove accents',
    category: 'string',
    description: 'Remove acentos e outros sinais diacríticos.',
    params: [],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v) =>
      toText(v)
        .normalize('NFD')
        .replace(/\p{M}+/gu, ''),
    sample: { input: 'São João', params: {} },
  },
  {
    id: 'padStart',
    label: 'PadStart',
    category: 'string',
    description: 'Completa o início do texto até o comprimento indicado.',
    params: [
      { key: 'length', label: 'Comprimento', type: 'number', required: true, default: 8 },
      { key: 'char', label: 'Preenchimento', type: 'string', default: '0' },
    ],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v, p) => toText(v).padStart(pNum(p, 'length'), pStr(p, 'char', ' ')),
    sample: { input: '42', params: { length: 6, char: '0' } },
  },
  {
    id: 'padEnd',
    label: 'PadEnd',
    category: 'string',
    description: 'Completa o fim do texto até o comprimento indicado.',
    params: [
      { key: 'length', label: 'Comprimento', type: 'number', required: true, default: 8 },
      { key: 'char', label: 'Preenchimento', type: 'string', default: ' ' },
    ],
    kind: 'scalar',
    accepts: TEXT_INPUTS,
    output: 'string',
    apply: (v, p) => toText(v).padEnd(pNum(p, 'length'), pStr(p, 'char', ' ')),
    sample: { input: 'abc', params: { length: 6, char: '.' } },
  },
  // ---------------------------------------------------------------- Numbers
  {
    id: 'stringToNumber',
    label: 'String to Number',
    category: 'number',
    description: 'Converte texto em número, com separador decimal configurável.',
    params: [
      {
        key: 'decimalSeparator',
        label: 'Separador decimal',
        type: 'select',
        default: '.',
        options: [
          { value: '.', label: 'Ponto: 1234.56' },
          { value: ',', label: 'Vírgula: 1.234,56' },
        ],
      },
    ],
    kind: 'scalar',
    accepts: ['string', 'number', 'integer', 'enum', 'any'],
    output: 'number',
    apply: (v, p) => {
      if (typeof v === 'number') return v;
      const text = toText(v).trim();
      const normalized =
        pStr(p, 'decimalSeparator', '.') === ',' ? text.replace(/\./g, '').replace(',', '.') : text;
      return requireNumber(normalized, 'String to Number');
    },
    sample: { input: '1.234,56', params: { decimalSeparator: ',' } },
  },
  {
    id: 'numberToString',
    label: 'Number to String',
    category: 'number',
    description: 'Converte número em texto, com casas decimais opcionais.',
    params: [
      {
        key: 'digits',
        label: 'Casas decimais',
        type: 'number',
        help: 'Vazio mantém o valor original.',
      },
    ],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'string',
    apply: (v, p) => {
      const n = requireNumber(v, 'Number to String');
      const digits = p['digits'];
      return isNil(digits) || digits === '' ? String(n) : n.toFixed(pNum(p, 'digits'));
    },
    sample: { input: 150.5, params: { digits: 2 } },
  },
  {
    id: 'round',
    label: 'Round',
    category: 'number',
    description: 'Arredonda para o número de casas indicado.',
    params: [{ key: 'digits', label: 'Casas decimais', type: 'number', default: 0 }],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: (_, p) => (pNum(p, 'digits') > 0 ? 'number' : 'integer'),
    apply: (v, p) => jsRound(requireNumber(v, 'Round'), pNum(p, 'digits')),
    sample: { input: 3.14159, params: { digits: 2 } },
  },
  {
    id: 'floor',
    label: 'Floor',
    category: 'number',
    description: 'Arredonda para baixo.',
    params: [],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'integer',
    apply: (v) => Math.floor(requireNumber(v, 'Floor')),
    sample: { input: 3.9, params: {} },
  },
  {
    id: 'ceil',
    label: 'Ceil',
    category: 'number',
    description: 'Arredonda para cima.',
    params: [],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'integer',
    apply: (v) => Math.ceil(requireNumber(v, 'Ceil')),
    sample: { input: 3.1, params: {} },
  },
  {
    id: 'abs',
    label: 'Absolute',
    category: 'number',
    description: 'Valor absoluto.',
    params: [],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'number',
    apply: (v) => Math.abs(requireNumber(v, 'Absolute')),
    sample: { input: -12.5, params: {} },
  },
  ...(
    [
      ['multiply', 'Multiply', 'Multiplica pelo operando.', (a: number, b: number) => a * b, 2],
      [
        'divide',
        'Divide',
        'Divide pelo operando. Divisão por zero gera erro.',
        (a: number, b: number) => a / b,
        2,
      ],
      ['add', 'Add', 'Soma o operando.', (a: number, b: number) => a + b, 10],
      ['subtract', 'Subtract', 'Subtrai o operando.', (a: number, b: number) => a - b, 10],
    ] as const
  ).map(([id, label, description, op, sampleOperand]): TransformDefinition => ({
    id,
    label,
    category: 'number',
    description,
    params: [
      { key: 'operand', label: 'Operando', type: 'number', required: true, default: sampleOperand },
    ],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'number',
    validate: (p) =>
      id === 'divide' && pNum(p, 'operand', 1) === 0 ? 'O divisor não pode ser zero.' : null,
    apply: (v, p) => {
      const operand = pNum(p, 'operand');
      if (id === 'divide' && operand === 0) throw new TransformError('Divide: divisão por zero.');
      return op(requireNumber(v, label), operand);
    },
    sample: { input: 100, params: { operand: sampleOperand } },
  })),
  {
    id: 'precision',
    label: 'Decimal precision',
    category: 'number',
    description: 'Fixa o número de casas decimais do valor numérico.',
    params: [
      { key: 'digits', label: 'Casas decimais', type: 'number', required: true, default: 2 },
    ],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'number',
    apply: (v, p) => Number(requireNumber(v, 'Decimal precision').toFixed(pNum(p, 'digits'))),
    sample: { input: 10.126, params: { digits: 2 } },
  },
  // ---------------------------------------------------------------- Dates
  {
    id: 'stringToDate',
    label: 'String to Date',
    category: 'date',
    description: 'Interpreta um texto como data e normaliza para o formato ISO.',
    params: [
      {
        key: 'pattern',
        label: 'Padrão de entrada',
        type: 'string',
        help: `Vazio espera ISO. ${PATTERN_HELP}`,
        placeholder: 'dd/MM/yyyy',
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: (_, p) => (/HH/.test(pStr(p, 'pattern')) ? 'datetime' : 'date'),
    validate: (p) =>
      pStr(p, 'pattern') && !isValidPattern(pStr(p, 'pattern')) ? 'Padrão de data inválido.' : null,
    apply: (v, p) => serializeDate(readDate(v, pStr(p, 'pattern'), 'String to Date')),
    sample: { input: '17/05/2024', params: { pattern: 'dd/MM/yyyy' } },
  },
  {
    id: 'dateToString',
    label: 'Date to String',
    category: 'date',
    description: 'Escreve uma data ISO como texto no padrão indicado.',
    params: [
      {
        key: 'pattern',
        label: 'Padrão de saída',
        type: 'string',
        required: true,
        default: 'dd/MM/yyyy',
        help: PATTERN_HELP,
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'string',
    validate: (p) => (isValidPattern(pStr(p, 'pattern')) ? null : 'Padrão de data inválido.'),
    apply: (v, p) => formatWithPattern(readDate(v, '', 'Date to String'), pStr(p, 'pattern')),
    sample: { input: '2024-05-17', params: { pattern: 'dd/MM/yyyy' } },
  },
  {
    id: 'toIso8601',
    label: 'ISO 8601',
    category: 'date',
    description: 'Gera o instante em UTC. Datas sem deslocamento são lidas no fuso indicado.',
    params: [
      {
        key: 'timeZone',
        label: 'Fuso da entrada',
        type: 'string',
        default: 'UTC',
        placeholder: 'America/Sao_Paulo',
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'datetime',
    validate: (p) =>
      isValidTimeZone(pStr(p, 'timeZone', 'UTC')) ? null : 'Fuso horário inválido.',
    apply: (v, p) =>
      new Date(
        toEpochMillis(readDate(v, '', 'ISO 8601'), pStr(p, 'timeZone', 'UTC')),
      ).toISOString(),
    sample: { input: '2024-05-17T10:30:00', params: { timeZone: 'America/Sao_Paulo' } },
  },
  {
    id: 'formatDate',
    label: 'Format date',
    category: 'date',
    description: 'Converte uma data de um padrão para outro.',
    params: [
      {
        key: 'inputPattern',
        label: 'Padrão de entrada',
        type: 'string',
        help: `Vazio espera ISO. ${PATTERN_HELP}`,
        placeholder: 'yyyyMMdd',
      },
      {
        key: 'pattern',
        label: 'Padrão de saída',
        type: 'string',
        required: true,
        default: 'yyyy-MM-dd',
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'string',
    validate: (p) =>
      isValidPattern(pStr(p, 'pattern')) &&
      (!pStr(p, 'inputPattern') || isValidPattern(pStr(p, 'inputPattern')))
        ? null
        : 'Padrão de data inválido.',
    apply: (v, p) =>
      formatWithPattern(readDate(v, pStr(p, 'inputPattern'), 'Format date'), pStr(p, 'pattern')),
    sample: { input: '20240517', params: { inputPattern: 'yyyyMMdd', pattern: 'dd/MM/yyyy' } },
  },
  {
    id: 'convertTimezone',
    label: 'Convert timezone',
    category: 'date',
    description: 'Reescreve o instante no fuso de destino, com o deslocamento correspondente.',
    params: [
      {
        key: 'from',
        label: 'Fuso de origem',
        type: 'string',
        default: 'UTC',
        help: 'Usado apenas quando a data não traz deslocamento.',
      },
      {
        key: 'to',
        label: 'Fuso de destino',
        type: 'string',
        required: true,
        default: 'America/Sao_Paulo',
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'datetime',
    validate: (p) =>
      isValidTimeZone(pStr(p, 'from', 'UTC')) && isValidTimeZone(pStr(p, 'to'))
        ? null
        : 'Fuso horário inválido.',
    apply: (v, p) => {
      const instant = toEpochMillis(readDate(v, '', 'Convert timezone'), pStr(p, 'from', 'UTC'));
      return serializeDate(instantToZone(instant, pStr(p, 'to')));
    },
    sample: { input: '2024-05-17T12:00:00Z', params: { from: 'UTC', to: 'America/Sao_Paulo' } },
  },
  {
    id: 'datePart',
    label: 'Extract date part',
    category: 'date',
    description: 'Extrai o dia, o mês ou o ano de uma data.',
    params: [
      {
        key: 'part',
        label: 'Parte',
        type: 'select',
        default: 'year',
        options: [
          { value: 'day', label: 'Dia' },
          { value: 'month', label: 'Mês' },
          { value: 'year', label: 'Ano' },
        ],
      },
    ],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'integer',
    apply: (v, p) => {
      const d = readDate(v, '', 'Extract date part');
      const part = pStr(p, 'part', 'year');
      return part === 'day' ? d.day : part === 'month' ? d.month : d.year;
    },
    sample: { input: '2024-05-17', params: { part: 'month' } },
  },
  {
    id: 'isValidDate',
    label: 'Validate date',
    category: 'date',
    description: 'Devolve verdadeiro se o texto for uma data real no padrão indicado.',
    params: [{ key: 'pattern', label: 'Padrão', type: 'string', help: 'Vazio espera ISO.' }],
    kind: 'scalar',
    accepts: DATE_INPUTS,
    output: 'boolean',
    apply: (v, p) => {
      const pattern = pStr(p, 'pattern');
      return (pattern ? parseWithPattern(toText(v), pattern) : parseIsoDate(toText(v))) !== null;
    },
    sample: { input: '2024-02-30', params: {} },
  },
  // ---------------------------------------------------------------- Boolean
  {
    id: 'stringToBoolean',
    label: 'String to Boolean',
    category: 'boolean',
    description: 'Converte texto em booleano com listas configuráveis de valores.',
    params: [
      {
        key: 'trueValues',
        label: 'Valores verdadeiros',
        type: 'list',
        default: 'true,1,yes,y,sim,s',
      },
      {
        key: 'falseValues',
        label: 'Valores falsos',
        type: 'list',
        default: 'false,0,no,n,nao,não',
      },
    ],
    kind: 'scalar',
    accepts: ['string', 'boolean', 'integer', 'number', 'enum', 'any'],
    output: 'boolean',
    apply: (v, p) => {
      if (typeof v === 'boolean') return v;
      const text = toText(v).trim().toLowerCase();
      const list = (key: string, fallback: string) =>
        (pList(p, key).length ? pList(p, key) : fallback.split(',')).map((s) => s.toLowerCase());
      if (list('trueValues', 'true,1,yes,y,sim,s').includes(text)) return true;
      if (list('falseValues', 'false,0,no,n,nao,não').includes(text)) return false;
      throw new TransformError(
        `String to Boolean: "${toText(v)}" não está nas listas configuradas.`,
      );
    },
    sample: { input: 'sim', params: {} },
  },
  {
    id: 'numberToBoolean',
    label: 'Number to Boolean',
    category: 'boolean',
    description: 'Zero é falso; qualquer outro número é verdadeiro.',
    params: [],
    kind: 'scalar',
    accepts: NUM_INPUTS,
    output: 'boolean',
    apply: (v) => requireNumber(v, 'Number to Boolean') !== 0,
    sample: { input: 1, params: {} },
  },
  {
    id: 'booleanToString',
    label: 'Boolean to String',
    category: 'boolean',
    description: 'Converte booleano em texto, com rótulos customizados.',
    params: [
      { key: 'trueLabel', label: 'Texto para verdadeiro', type: 'string', default: 'true' },
      { key: 'falseLabel', label: 'Texto para falso', type: 'string', default: 'false' },
    ],
    kind: 'scalar',
    accepts: ['boolean', 'any'],
    output: 'string',
    apply: (v, p) => {
      if (typeof v !== 'boolean')
        throw new TransformError(`Boolean to String: "${toText(v)}" não é booleano.`);
      return v ? pStr(p, 'trueLabel', 'true') : pStr(p, 'falseLabel', 'false');
    },
    sample: { input: true, params: { trueLabel: 'Ativo', falseLabel: 'Inativo' } },
  },
  // ---------------------------------------------------------------- Utilitários
  {
    id: 'defaultValue',
    label: 'Default Value',
    category: 'utility',
    description: 'Usa o valor indicado quando a entrada é nula, ausente ou, se configurado, vazia.',
    params: [
      { key: 'value', label: 'Valor padrão', type: 'literal', required: true },
      {
        key: 'emptyAsNull',
        label: 'Tratar texto vazio como nulo',
        type: 'boolean',
        default: false,
      },
    ],
    kind: 'any',
    handlesNull: true,
    accepts: 'any',
    output: (input) => input,
    apply: (v, p) => {
      if (isNil(v) || (pBool(p, 'emptyAsNull') && v === '')) return p['value'] ?? null;
      return v;
    },
    sample: { input: null, params: { value: 'N/A' } },
  },
  {
    id: 'coalesce',
    label: 'Coalesce',
    category: 'utility',
    description: 'Devolve o primeiro valor não nulo entre a entrada e os campos indicados.',
    params: [{ key: 'paths', label: 'Campos alternativos', type: 'pathList', required: true }],
    kind: 'any',
    handlesNull: true,
    accepts: 'any',
    output: (input) => input,
    validate: (p) =>
      pList(p, 'paths').every(isValidPath) ? null : 'Caminho inválido em "Campos alternativos".',
    apply: (v, p, ctx) => {
      if (!isNil(v)) return v;
      for (const path of pList(p, 'paths')) {
        const alt = ctx.resolve(path);
        if (!isNil(alt)) return alt;
      }
      return v;
    },
    sample: { input: null, params: { paths: [] } },
  },
  {
    id: 'conditional',
    label: 'Conditional Mapping',
    category: 'utility',
    description:
      'Escolhe o resultado comparando a entrada. Campos vazios mantêm o valor de entrada.',
    params: [
      {
        key: 'operator',
        label: 'Operador',
        type: 'select',
        default: 'eq',
        options: OPERATOR_OPTIONS,
      },
      { key: 'compare', label: 'Comparar com', type: 'literal' },
      { key: 'thenValue', label: 'Resultado se verdadeiro', type: 'literal' },
      { key: 'elseValue', label: 'Resultado se falso', type: 'literal' },
    ],
    kind: 'scalar',
    handlesNull: true,
    accepts: SCALAR_INPUTS,
    output: (input, p) => {
      const sample = p['thenValue'] ?? p['elseValue'];
      if (typeof sample === 'string') return 'string';
      if (typeof sample === 'number') return 'number';
      if (typeof sample === 'boolean') return 'boolean';
      return input;
    },
    apply: (v, p) => {
      const pick = evaluate(v, pStr(p, 'operator', 'eq') as ConditionOperator, p['compare'])
        ? p['thenValue']
        : p['elseValue'];
      return pick === undefined ? v : pick;
    },
    sample: {
      input: 15,
      params: { operator: 'gte', compare: 18, thenValue: 'adulto', elseValue: 'menor' },
    },
  },
  {
    id: 'constant',
    label: 'Constant Value',
    category: 'utility',
    description: 'Ignora a entrada e escreve sempre o mesmo valor.',
    params: [{ key: 'value', label: 'Valor', type: 'literal', required: true }],
    kind: 'any',
    handlesNull: true,
    accepts: 'any',
    output: (_, p) => {
      const v = p['value'];
      return typeof v === 'string'
        ? 'string'
        : typeof v === 'number'
          ? 'number'
          : typeof v === 'boolean'
            ? 'boolean'
            : 'any';
    },
    apply: (_, p) => p['value'] ?? null,
    sample: { input: 'qualquer', params: { value: 'BRL' } },
  },
  {
    id: 'lookup',
    label: 'Lookup Table',
    category: 'utility',
    description: 'Troca o valor pela entrada correspondente de uma tabela.',
    params: [
      { key: 'table', label: 'Tabela', type: 'table', required: true },
      { key: 'fallback', label: 'Valor quando não encontrar', type: 'literal' },
      {
        key: 'keepUnmatched',
        label: 'Manter valor original se não encontrar',
        type: 'boolean',
        default: false,
      },
    ],
    kind: 'scalar',
    accepts: SCALAR_INPUTS,
    output: 'any',
    apply: (v, p) => {
      const hit = ownProp(pTable(p, 'table'), toText(v));
      if (hit !== undefined) return hit;
      if (p['fallback'] !== undefined) return p['fallback'];
      return pBool(p, 'keepUnmatched') ? v : null;
    },
    sample: { input: 'SP', params: { table: { SP: 'São Paulo', RJ: 'Rio de Janeiro' } } },
  },
  {
    id: 'enumMap',
    label: 'Enum Mapping',
    category: 'utility',
    description: 'Converte entre enumerações. No modo estrito, valor desconhecido gera erro.',
    params: [
      { key: 'table', label: 'De/para', type: 'table', required: true },
      { key: 'strict', label: 'Estrito', type: 'boolean', default: true },
    ],
    kind: 'scalar',
    accepts: SCALAR_INPUTS,
    output: 'enum',
    apply: (v, p) => {
      const hit = ownProp(pTable(p, 'table'), toText(v));
      if (hit !== undefined) return hit;
      if (pBool(p, 'strict', true))
        throw new TransformError(`Enum Mapping: "${toText(v)}" não tem correspondência.`);
      return v;
    },
    sample: { input: 'PAGO', params: { table: { PAGO: 'PAID', PENDENTE: 'PENDING' } } },
  },
  {
    id: 'nullHandling',
    label: 'Null Handling',
    category: 'utility',
    description: 'Define o que fazer com valores nulos ou ausentes.',
    params: [
      {
        key: 'mode',
        label: 'Ação',
        type: 'select',
        default: 'omit',
        options: [
          { value: 'keep', label: 'Manter como null' },
          { value: 'omit', label: 'Omitir o campo' },
          { value: 'empty-string', label: 'Trocar por texto vazio' },
          { value: 'zero', label: 'Trocar por zero' },
          { value: 'false', label: 'Trocar por false' },
          { value: 'error', label: 'Gerar erro' },
        ],
      },
    ],
    kind: 'any',
    handlesNull: true,
    accepts: 'any',
    output: (input) => input,
    apply: (v, p) => {
      if (!isNil(v)) return v;
      switch (pStr(p, 'mode', 'omit')) {
        case 'keep':
          return null;
        case 'empty-string':
          return '';
        case 'zero':
          return 0;
        case 'false':
          return false;
        case 'error':
          throw new TransformError('Null Handling: valor nulo ou ausente.');
        default:
          return undefined;
      }
    },
    sample: { input: null, params: { mode: 'zero' } },
  },
  {
    id: 'removeEmpty',
    label: 'Remove Empty Values',
    category: 'utility',
    description: 'Remove nulos, textos vazios, listas e objetos vazios, recursivamente.',
    params: [],
    kind: 'any',
    accepts: 'any',
    output: (input) => input,
    apply: (v) => removeEmpty(v),
    sample: { input: { a: 1, b: null, c: '', d: [] }, params: {} },
  },
  // ---------------------------------------------------------------- Arrays
  {
    id: 'filter',
    label: 'Filter',
    category: 'array',
    description: 'Mantém os itens da lista que atendem à condição.',
    params: [
      { key: 'field', label: 'Campo do item', type: 'path', help: 'Vazio compara o próprio item.' },
      {
        key: 'operator',
        label: 'Operador',
        type: 'select',
        default: 'eq',
        options: OPERATOR_OPTIONS,
      },
      { key: 'value', label: 'Valor', type: 'literal' },
    ],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'same',
    apply: (v, p) =>
      asArray(v, 'Filter').filter((el) =>
        evaluate(
          fieldOf(el, pStr(p, 'field')),
          pStr(p, 'operator', 'eq') as ConditionOperator,
          p['value'],
        ),
      ),
    sample: { input: [10, 25, 40], params: { operator: 'gt', value: 20 } },
  },
  {
    id: 'map',
    label: 'Map',
    category: 'array',
    description: 'Troca cada item da lista por um de seus campos.',
    params: [{ key: 'field', label: 'Campo do item', type: 'path', required: true }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'array',
    outputItem: 'any',
    apply: (v, p) => asArray(v, 'Map').map((el) => fieldOf(el, pStr(p, 'field')) ?? null),
    sample: { input: [{ id: 1 }, { id: 2 }], params: { field: 'id' } },
  },
  {
    id: 'distinct',
    label: 'Distinct',
    category: 'array',
    description: 'Remove repetições, mantendo a primeira ocorrência.',
    params: [
      { key: 'field', label: 'Campo-chave', type: 'path', help: 'Vazio compara o item inteiro.' },
    ],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'same',
    apply: (v, p) => {
      const seen = new Set<string>();
      return asArray(v, 'Distinct').filter((el) => {
        const key = JSON.stringify(fieldOf(el, pStr(p, 'field')) ?? null);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    sample: { input: [1, 2, 2, 3, 1], params: {} },
  },
  {
    id: 'sort',
    label: 'Sort',
    category: 'array',
    description: 'Ordena a lista, de forma estável. Nulos ficam sempre no fim.',
    params: [
      {
        key: 'field',
        label: 'Campo do item',
        type: 'path',
        help: 'Vazio ordena pelo próprio item.',
      },
      { key: 'direction', label: 'Direção', type: 'select', default: 'asc', options: SORT_OPTIONS },
    ],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'same',
    apply: (v, p) => sortItems(asArray(v, 'Sort'), pStr(p, 'field'), pStr(p, 'direction', 'asc')),
    sample: { input: [3, 1, 2], params: { direction: 'desc' } },
  },
  {
    id: 'count',
    label: 'Count',
    category: 'array',
    description: 'Quantidade de itens da lista. Lista nula ou ausente conta zero.',
    params: [],
    kind: 'array',
    handlesNull: true,
    accepts: ['array', 'any'],
    output: 'integer',
    apply: (v) => (isNil(v) ? 0 : asArray(v, 'Count').length),
    sample: { input: ['a', 'b', 'c'], params: {} },
  },
  {
    id: 'sum',
    label: 'Sum',
    category: 'array',
    description: 'Soma os itens numéricos. Nulos são ignorados; lista vazia soma zero.',
    params: [{ key: 'field', label: 'Campo do item', type: 'path' }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'item',
    apply: (v, p) => numericItems(v, pStr(p, 'field'), 'Sum').reduce((a, b) => a + b, 0),
    sample: { input: [150.5, 250], params: {} },
  },
  {
    id: 'average',
    label: 'Average',
    category: 'array',
    description: 'Média dos itens numéricos. Lista vazia resulta em nulo.',
    params: [{ key: 'field', label: 'Campo do item', type: 'path' }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'number',
    apply: (v, p) => {
      const nums = numericItems(v, pStr(p, 'field'), 'Average');
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    },
    sample: { input: [10, 20, 60], params: {} },
  },
  {
    id: 'min',
    label: 'Min',
    category: 'array',
    description: 'Menor item da lista, ignorando nulos.',
    params: [{ key: 'field', label: 'Campo do item', type: 'path' }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'item',
    apply: (v, p) => extreme(v, pStr(p, 'field'), -1, 'Min'),
    sample: { input: [5, 2, 9], params: {} },
  },
  {
    id: 'max',
    label: 'Max',
    category: 'array',
    description: 'Maior item da lista, ignorando nulos.',
    params: [{ key: 'field', label: 'Campo do item', type: 'path' }],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'item',
    apply: (v, p) => extreme(v, pStr(p, 'field'), 1, 'Max'),
    sample: { input: [5, 2, 9], params: {} },
  },
  {
    id: 'first',
    label: 'First',
    category: 'array',
    description: 'Primeiro item da lista. Lista vazia resulta em nulo.',
    params: [],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'item',
    apply: (v) => asArray(v, 'First')[0] ?? null,
    sample: { input: ['a', 'b'], params: {} },
  },
  {
    id: 'last',
    label: 'Last',
    category: 'array',
    description: 'Último item da lista. Lista vazia resulta em nulo.',
    params: [],
    kind: 'array',
    accepts: ['array', 'any'],
    output: 'item',
    apply: (v) => {
      const list = asArray(v, 'Last');
      return list.length ? list[list.length - 1] : null;
    },
    sample: { input: ['a', 'b'], params: {} },
  },
];

export function sortItems(list: JsonValue[], field: string, direction: string): JsonValue[] {
  const dir = direction === 'desc' ? -1 : 1;
  return list
    .map((el, i) => ({ el, i, key: fieldOf(el, field) }))
    .sort((a, b) => {
      const an = isNil(a.key);
      const bn = isNil(b.key);
      if (an || bn) return an && bn ? a.i - b.i : an ? 1 : -1;
      return compareValues(a.key, b.key) * dir || a.i - b.i;
    })
    .map((x) => x.el);
}

function numericItems(v: Value, field: string, label: string): number[] {
  return asArray(v, label)
    .map((el) => fieldOf(el, field))
    .filter((x) => !isNil(x))
    .map((x) => requireNumber(x, label));
}

function extreme(v: Value, field: string, sign: 1 | -1, label: string): JsonValue {
  let best: Value = undefined;
  for (const el of asArray(v, label)) {
    const x = fieldOf(el, field);
    if (isNil(x)) continue;
    if (best === undefined || compareValues(x, best) * sign > 0) best = x;
  }
  return best === undefined ? null : best;
}

const BY_ID = new Map(TRANSFORMS.map((t) => [t.id, t]));

export function getTransform(id: string): TransformDefinition | undefined {
  return BY_ID.get(id);
}

export const CATEGORY_LABELS: Record<TransformCategory, string> = {
  string: 'Strings',
  number: 'Numbers',
  date: 'Dates',
  boolean: 'Boolean',
  utility: 'Utilitários',
  array: 'Arrays',
};

/** Parâmetros iniciais de uma etapa nova. */
export function defaultParams(def: TransformDefinition): TransformParams {
  const params: TransformParams = {};
  for (const p of def.params) if (p.default !== undefined) params[p.key] = p.default;
  return params;
}

/** Erros de configuração de uma etapa; lista vazia significa etapa válida. */
export function validateStep(step: TransformStep): string[] {
  const def = BY_ID.get(step.transformId);
  if (!def) return [`Transformação desconhecida: "${step.transformId}".`];
  const errors: string[] = [];
  for (const p of def.params) {
    const v = step.params[p.key];
    const missing =
      v === undefined || v === '' || (p.type === 'table' && isObject(v) && !Object.keys(v).length);
    if (p.required && missing && p.type !== 'literal')
      errors.push(`${def.label}: informe "${p.label}".`);
    if (p.required && p.type === 'literal' && v === undefined)
      errors.push(`${def.label}: informe "${p.label}".`);
    if (p.type === 'number' && v !== undefined && v !== '' && !Number.isFinite(Number(v))) {
      errors.push(`${def.label}: "${p.label}" deve ser numérico.`);
    }
    if (p.type === 'path' && typeof v === 'string' && v !== '' && !isValidPath(v)) {
      errors.push(`${def.label}: caminho inválido em "${p.label}".`);
    }
  }
  const custom = def.validate?.(step.params);
  if (custom) errors.push(`${def.label}: ${custom}`);
  return errors;
}

export interface TypeFlow {
  type: FieldType;
  itemType?: FieldType;
}

/** Propaga o tipo estático por uma etapa; o elemento de listas é tratado pelas `scalar`. */
export function flowStep(flow: TypeFlow, step: TransformStep): TypeFlow {
  const def = BY_ID.get(step.transformId);
  if (!def || step.disabled) return flow;
  const resolve = (input: FieldType): FieldType => {
    if (def.output === 'same' || def.output === 'item') return input;
    return typeof def.output === 'function' ? def.output(input, step.params) : def.output;
  };
  if (def.kind === 'scalar' && flow.type === 'array') {
    const inner = flow.itemType ?? 'any';
    return { type: 'array', itemType: def.output === 'array' ? 'array' : resolve(inner) };
  }
  if (def.output === 'item') return { type: flow.itemType ?? 'any' };
  if (def.output === 'same') return flow;
  const type = resolve(flow.type);
  return type === 'array'
    ? { type, itemType: def.outputItem === 'same' ? flow.itemType : (def.outputItem ?? 'any') }
    : { type };
}
