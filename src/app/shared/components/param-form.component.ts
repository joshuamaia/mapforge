import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { JsonValue } from '../../core/models/json.model';
import { TransformParams } from '../../core/models/mapping.model';
import { ParamDef, TransformDefinition } from '../../core/transformations/catalog';

/** Texto digitado como literal: JSON válido vira o valor tipado; o resto é texto. */
export function parseLiteral(text: string): JsonValue | undefined {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export function formatLiteral(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function parseTable(text: string): Record<string, JsonValue> {
  const table: Record<string, JsonValue> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key === '__proto__') continue;
    table[key] = parseLiteral(line.slice(at + 1).trim()) ?? '';
  }
  return table;
}

export function formatTable(value: JsonValue | undefined): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value)
    .map(([k, v]) => `${k}=${formatLiteral(v)}`)
    .join('\n');
}

/** Formulário gerado a partir da definição dos parâmetros da transformação. */
@Component({
  selector: 'mf-param-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (p of definition().params; track p.key) {
      <div class="field">
        <label [attr.for]="id(p)"
          >{{ p.label }}
          @if (p.required) {
            <span class="req" aria-hidden="true"> *</span>
          }
        </label>
        @switch (p.type) {
          @case ('boolean') {
            <input
              type="checkbox"
              [id]="id(p)"
              [checked]="boolValue(p)"
              (change)="set(p, $any($event.target).checked)"
            />
          }
          @case ('select') {
            <select [id]="id(p)" [value]="text(p)" (change)="set(p, $any($event.target).value)">
              @for (o of p.options; track o.value) {
                <option [value]="o.value" [selected]="o.value === text(p)">{{ o.label }}</option>
              }
            </select>
          }
          @case ('number') {
            <input
              type="number"
              step="any"
              [id]="id(p)"
              [value]="text(p)"
              (input)="setNumber(p, $any($event.target).value)"
            />
          }
          @case ('table') {
            <textarea
              rows="4"
              [id]="id(p)"
              [value]="tableText(p)"
              placeholder="CHAVE=valor"
              spellcheck="false"
              (change)="set(p, parseTable($any($event.target).value))"
            ></textarea>
            <small>Uma entrada por linha, no formato chave=valor.</small>
          }
          @case ('literal') {
            <input
              [id]="id(p)"
              [value]="literalText(p)"
              [placeholder]="p.placeholder ?? 'texto, 10, true ou null'"
              spellcheck="false"
              (input)="set(p, parseLiteral($any($event.target).value))"
            />
          }
          @case ('pathList') {
            <input
              [id]="id(p)"
              [value]="listText(p)"
              placeholder="campo.a, campo.b"
              spellcheck="false"
              (input)="setPathList(p, $any($event.target).value)"
            />
          }
          @default {
            <input
              [id]="id(p)"
              [value]="text(p)"
              [placeholder]="p.placeholder ?? ''"
              spellcheck="false"
              (input)="set(p, $any($event.target).value)"
            />
          }
        }
        @if (p.help) {
          <small>{{ p.help }}</small>
        }
      </div>
    } @empty {
      <p class="muted small">Esta transformação não tem parâmetros.</p>
    }
  `,
})
export class ParamFormComponent {
  readonly definition = input.required<TransformDefinition>();
  readonly params = input.required<TransformParams>();
  readonly idPrefix = input('p');
  readonly paramsChange = output<TransformParams>();

  protected readonly parseTable = parseTable;
  protected readonly parseLiteral = parseLiteral;

  protected id(p: ParamDef): string {
    return `${this.idPrefix()}-${p.key}`;
  }

  private current(p: ParamDef): JsonValue | undefined {
    return this.params()[p.key] ?? p.default;
  }

  protected text(p: ParamDef): string {
    const v = this.current(p);
    return v === undefined || v === null ? '' : String(v);
  }

  protected boolValue(p: ParamDef): boolean {
    return this.current(p) === true;
  }

  protected literalText(p: ParamDef): string {
    return formatLiteral(this.params()[p.key]);
  }

  protected tableText(p: ParamDef): string {
    return formatTable(this.params()[p.key]);
  }

  protected listText(p: ParamDef): string {
    const v = this.params()[p.key];
    return Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v);
  }

  protected set(p: ParamDef, value: JsonValue | undefined): void {
    const next = { ...this.params() };
    if (value === undefined) delete next[p.key];
    else next[p.key] = value;
    this.paramsChange.emit(next);
  }

  protected setNumber(p: ParamDef, raw: string): void {
    this.set(p, raw === '' ? undefined : Number(raw));
  }

  protected setPathList(p: ParamDef, raw: string): void {
    this.set(
      p,
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
  }
}
