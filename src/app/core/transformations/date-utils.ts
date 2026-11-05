/**
 * Datas determinísticas, independentes do fuso da máquina: horários locais nunca passam por
 * `Date`, que os interpretaria no fuso do navegador. Tokens de padrão suportados (mesma
 * semântica nos helpers gerados em Java e TypeScript):
 *   yyyy MM dd HH mm ss SSS XXX e literais entre aspas simples ('T').
 */
export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millis: number;
  hasTime: boolean;
  /** Deslocamento em minutos; `null` para data/hora local. */
  offset: number | null;
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidParts(p: DateParts): boolean {
  return (
    p.month >= 1 &&
    p.month <= 12 &&
    p.day >= 1 &&
    p.day <= daysInMonth(p.year, p.month) &&
    p.hour >= 0 &&
    p.hour <= 23 &&
    p.minute >= 0 &&
    p.minute <= 59 &&
    p.second >= 0 &&
    p.second <= 59
  );
}

function parseOffset(text: string): number {
  if (text === 'Z') return 0;
  const sign = text[0] === '-' ? -1 : 1;
  const digits = text.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

export function parseIsoDate(text: string): DateParts | null {
  const m = ISO.exec(text.trim());
  if (!m) return null;
  const parts: DateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
    second: m[6] ? Number(m[6]) : 0,
    millis: m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0,
    hasTime: m[4] !== undefined,
    offset: m[8] ? parseOffset(m[8]) : null,
  };
  return isValidParts(parts) ? parts : null;
}

type PatternToken =
  { token: 'yyyy' | 'MM' | 'dd' | 'HH' | 'mm' | 'ss' | 'SSS' | 'XXX' } | { literal: string };

const TOKENS = ['yyyy', 'SSS', 'XXX', 'MM', 'dd', 'HH', 'mm', 'ss'] as const;

export function tokenizePattern(pattern: string): PatternToken[] {
  const out: PatternToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end < 0) throw new Error('Literal entre aspas não terminado no padrão de data.');
      out.push({ literal: end === i + 1 ? "'" : pattern.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const tok = TOKENS.find((t) => pattern.startsWith(t, i));
    if (tok) {
      out.push({ token: tok });
      i += tok.length;
    } else if (/[A-Za-z]/.test(pattern[i])) {
      throw new Error(`Token "${pattern[i]}" não suportado no padrão de data.`);
    } else {
      out.push({ literal: pattern[i] });
      i++;
    }
  }
  return out;
}

export function isValidPattern(pattern: string): boolean {
  try {
    tokenizePattern(pattern);
    return pattern.length > 0;
  } catch {
    return false;
  }
}

export function parseWithPattern(text: string, pattern: string): DateParts | null {
  const parts: DateParts = {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millis: 0,
    hasTime: false,
    offset: null,
  };
  let i = 0;
  const value = text.trim();
  const digits = (n: number): number | null => {
    const slice = value.slice(i, i + n);
    if (slice.length !== n || !/^\d+$/.test(slice)) return null;
    i += n;
    return Number(slice);
  };
  for (const t of tokenizePattern(pattern)) {
    if ('literal' in t) {
      if (!value.startsWith(t.literal, i)) return null;
      i += t.literal.length;
      continue;
    }
    if (t.token === 'XXX') {
      const m = /^(Z|[+-]\d{2}:\d{2})/.exec(value.slice(i));
      if (!m) return null;
      parts.offset = parseOffset(m[1]);
      i += m[1].length;
      parts.hasTime = true;
      continue;
    }
    const width = t.token === 'yyyy' ? 4 : t.token === 'SSS' ? 3 : 2;
    const n = digits(width);
    if (n === null) return null;
    if (t.token === 'yyyy') parts.year = n;
    else if (t.token === 'MM') parts.month = n;
    else if (t.token === 'dd') parts.day = n;
    else {
      parts.hasTime = true;
      if (t.token === 'HH') parts.hour = n;
      else if (t.token === 'mm') parts.minute = n;
      else if (t.token === 'ss') parts.second = n;
      else parts.millis = n;
    }
  }
  if (i !== value.length) return null;
  return isValidParts(parts) ? parts : null;
}

function formatOffset(offset: number): string {
  if (offset === 0) return 'Z';
  const abs = Math.abs(offset);
  return `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatWithPattern(p: DateParts, pattern: string): string {
  return tokenizePattern(pattern)
    .map((t) => {
      if ('literal' in t) return t.literal;
      switch (t.token) {
        case 'yyyy':
          return pad(p.year, 4);
        case 'MM':
          return pad(p.month);
        case 'dd':
          return pad(p.day);
        case 'HH':
          return pad(p.hour);
        case 'mm':
          return pad(p.minute);
        case 'ss':
          return pad(p.second);
        case 'SSS':
          return pad(p.millis, 3);
        case 'XXX':
          return p.offset === null ? '' : formatOffset(p.offset);
      }
    })
    .join('');
}

/** Forma normalizada: `2024-01-31` ou `2024-01-31T10:00:00[.SSS][Z|+hh:mm]`. */
export function serializeDate(p: DateParts): string {
  const date = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  if (!p.hasTime) return date;
  const ms = p.millis ? `.${pad(p.millis, 3)}` : '';
  const off = p.offset === null ? '' : formatOffset(p.offset);
  return `${date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${ms}${off}`;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.length > 0;
  } catch {
    return false;
  }
}

function zoneOffsetAt(epochMs: number, zone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const f: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') f[part.type] = Number(part.value);
  }
  const local = Date.UTC(f['year'], f['month'] - 1, f['day'], f['hour'], f['minute'], f['second']);
  return Math.round((local - Math.floor(epochMs / 1000) * 1000) / 60000);
}

/** Converte em instante; horários sem deslocamento são interpretados em `zone`. */
export function toEpochMillis(p: DateParts, zone: string): number {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millis);
  if (p.offset !== null) return wall - p.offset * 60000;
  let guess = wall - zoneOffsetAt(wall, zone) * 60000;
  guess = wall - zoneOffsetAt(guess, zone) * 60000;
  return guess;
}

export function instantToZone(epochMs: number, zone: string): DateParts {
  const offset = zoneOffsetAt(epochMs, zone);
  const d = new Date(epochMs + offset * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millis: d.getUTCMilliseconds(),
    hasTime: true,
    offset,
  };
}
