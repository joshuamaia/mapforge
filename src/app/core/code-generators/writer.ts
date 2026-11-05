/** Escreve código com indentação controlada. */
export class CodeWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  constructor(private readonly unit = '  ') {}

  line(text = ''): this {
    this.lines.push(text === '' ? '' : this.unit.repeat(this.depth) + text);
    return this;
  }

  /** Escreve várias linhas mantendo a indentação relativa. */
  block(text: string): this {
    for (const l of text.split('\n')) this.line(l);
    return this;
  }

  open(text: string): this {
    this.line(text);
    this.depth++;
    return this;
  }

  close(text = '}'): this {
    this.depth--;
    this.line(text);
    return this;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
