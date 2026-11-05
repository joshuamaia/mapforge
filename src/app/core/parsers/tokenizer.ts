/** Tokenizador compartilhado pelos parsers de Java e TypeScript. Descarta comentários. */
export type TokenKind = 'ident' | 'string' | 'number' | 'symbol' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
}

export class SourceSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'SourceSyntaxError';
  }
}

const isIdentStart = (c: string): boolean => /[\p{L}_$]/u.test(c);
const isIdentPart = (c: string): boolean => /[\p{L}\p{N}_$]/u.test(c);

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const pos = (): { line: number; column: number } => ({ line, column: i - lineStart + 1 });

  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      lineStart = i;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const start = pos();
      const end = text.indexOf('*/', i + 2);
      if (end < 0)
        throw new SourceSyntaxError('Comentário não terminado.', start.line, start.column);
      for (let j = i; j < end; j++) {
        if (text[j] === '\n') {
          line++;
          lineStart = j + 1;
        }
      }
      i = end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const start = pos();
      let value = '';
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) {
          j++;
          value += text[j] === 'n' ? '\n' : text[j] === 't' ? '\t' : text[j];
        } else {
          if (text[j] === '\n' && c !== '`') {
            throw new SourceSyntaxError('Texto não terminado.', start.line, start.column);
          }
          value += text[j];
        }
        j++;
      }
      if (j >= text.length)
        throw new SourceSyntaxError('Texto não terminado.', start.line, start.column);
      tokens.push({ kind: 'string', text: value, ...start });
      i = j + 1;
    } else if (isIdentStart(c)) {
      const start = pos();
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j])) j++;
      tokens.push({ kind: 'ident', text: text.slice(i, j), ...start });
      i = j;
    } else if (/\d/.test(c)) {
      const start = pos();
      let j = i + 1;
      while (j < text.length && /[\w.]/.test(text[j])) j++;
      tokens.push({ kind: 'number', text: text.slice(i, j), ...start });
      i = j;
    } else {
      const start = pos();
      const three = text.slice(i, i + 3);
      const two = text.slice(i, i + 2);
      const sym = three === '...' ? three : two === '=>' ? two : c;
      tokens.push({ kind: 'symbol', text: sym, ...start });
      i += sym.length;
    }
  }
  tokens.push({ kind: 'eof', text: '', line, column: i - lineStart + 1 });
  return tokens;
}

/** Cursor com utilitários de recursive descent. */
export class TokenStream {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  get current(): Token {
    return this.tokens[this.index];
  }

  peek(offset = 1): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  get atEnd(): boolean {
    return this.current.kind === 'eof';
  }

  next(): Token {
    const t = this.current;
    if (!this.atEnd) this.index++;
    return t;
  }

  is(text: string): boolean {
    return this.current.text === text && this.current.kind !== 'string';
  }

  accept(text: string): boolean {
    if (this.is(text)) {
      this.next();
      return true;
    }
    return false;
  }

  expect(text: string): Token {
    if (!this.is(text)) {
      this.fail(`Esperado "${text}", encontrado "${this.describe()}".`);
    }
    return this.next();
  }

  expectIdent(what: string): Token {
    if (this.current.kind !== 'ident') {
      this.fail(`Esperado ${what}, encontrado "${this.describe()}".`);
    }
    return this.next();
  }

  describe(): string {
    return this.atEnd ? 'fim do arquivo' : this.current.text;
  }

  fail(message: string): never {
    throw new SourceSyntaxError(message, this.current.line, this.current.column);
  }

  /** Pula um bloco balanceado; o token corrente deve ser o de abertura. */
  skipBalanced(open: string, close: string): void {
    const start = this.current;
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      if (this.atEnd) {
        throw new SourceSyntaxError(
          `"${open}" sem "${close}" correspondente.`,
          start.line,
          start.column,
        );
      }
      if (this.is(open)) depth++;
      else if (this.is(close)) depth--;
      this.next();
    }
  }

  /** Avança até um dos símbolos, fora de parênteses, colchetes, chaves e genéricos simples. */
  skipUntil(...stops: string[]): void {
    let depth = 0;
    while (!this.atEnd) {
      if (depth === 0 && stops.some((s) => this.is(s))) return;
      if (this.is('(') || this.is('[') || this.is('{')) depth++;
      else if (this.is(')') || this.is(']') || this.is('}')) {
        if (depth === 0) return;
        depth--;
      }
      this.next();
    }
  }
}
