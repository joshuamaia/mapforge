/** Seleciona trechos do runtime gerado (`//#region nome`) com suas dependências transitivas. */
export class RuntimeSections {
  private readonly sections = new Map<string, string>();

  constructor(template: string) {
    const lines = template.split(/\r?\n/);
    let name: string | null = null;
    let body: string[] = [];
    for (const line of lines) {
      const start = /^\/\/#region (\w+)/.exec(line);
      if (start) {
        name = start[1];
        body = [];
      } else if (line.startsWith('//#endregion')) {
        if (name) this.sections.set(name, body.join('\n'));
        name = null;
      } else if (name) {
        body.push(line);
      }
    }
  }

  has(name: string): boolean {
    return this.sections.has(name);
  }

  /** Devolve o código dos trechos usados em `code`, na ordem do template. */
  select(code: string): string[] {
    const used = new Set<string>();
    const visit = (text: string): void => {
      for (const name of this.sections.keys()) {
        if (!used.has(name) && new RegExp(`(?<![.\\w"'])${name}\\b`).test(text)) {
          used.add(name);
          visit(this.sections.get(name) as string);
        }
      }
    };
    visit(code);
    return [...this.sections.entries()].filter(([name]) => used.has(name)).map(([, body]) => body);
  }
}
