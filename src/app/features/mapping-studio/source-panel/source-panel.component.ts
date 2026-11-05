import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { StructureFormat } from '../../../core/models/schema.model';
import { ParseIssue } from '../../../core/models/schema.model';
import { ProjectStore, readTextFile } from '../../../core/services/project-store.service';
import { SettingsService } from '../../../core/services/settings.service';
import { ToastService } from '../../../core/services/ui.services';
import { FieldTreeComponent } from '../../../shared/components/field-tree.component';
import { IconComponent } from '../../../shared/components/icon.component';
import { MonacoEditorComponent } from '../../../shared/components/monaco-editor.component';
import { TooltipDirective } from '../../../shared/directives/tooltip.directive';
import { StudioState } from '../studio-state.service';

export const FORMAT_OPTIONS: { value: StructureFormat; label: string; language: string }[] = [
  { value: 'json', label: 'JSON', language: 'json' },
  { value: 'java', label: 'Java DTO', language: 'java' },
  { value: 'typescript', label: 'TypeScript', language: 'typescript' },
];

export function formatFromFileName(name: string): StructureFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.ts')) return 'typescript';
  return null;
}

export function firstError(issues: readonly ParseIssue[]): ParseIssue | null {
  return issues.find((i) => i.severity === 'error') ?? null;
}

@Component({
  selector: 'mf-source-panel',
  imports: [IconComponent, MonacoEditorComponent, FieldTreeComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-labelledby="source-title">
      <header class="panel-header">
        <h2 id="source-title">Source</h2>
        <select
          class="select-sm"
          aria-label="Formato da origem"
          data-testid="source-format"
          [value]="doc().source.format"
          (change)="store.setStructureFormat('source', $any($event.target).value)"
        >
          @for (o of formats; track o.value) {
            <option [value]="o.value" [selected]="o.value === doc().source.format">
              {{ o.label }}
            </option>
          }
        </select>
        <span class="spacer"></span>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Importar arquivo (.json, .java, .ts)"
          (click)="file.click()"
        >
          <mf-icon name="upload" />
        </button>
        <input
          #file
          class="sr-only"
          type="file"
          accept=".json,.java,.ts"
          tabindex="-1"
          aria-label="Importar arquivo de origem"
          data-testid="source-file"
          (change)="importFile($event)"
        />
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Format"
          data-testid="source-format-btn"
          (click)="format()"
        >
          <mf-icon name="format" />
        </button>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Validate"
          data-testid="source-validate"
          (click)="validate()"
        >
          <mf-icon name="check" />
        </button>
      </header>
      <div class="tabs tabs-sm" role="tablist" aria-label="Conteúdo da origem">
        <button
          role="tab"
          type="button"
          [attr.aria-selected]="tab() === 'structure'"
          (click)="tab.set('structure')"
        >
          {{ doc().source.format === 'json' ? 'JSON' : 'Estrutura' }}
        </button>
        <button
          role="tab"
          type="button"
          data-testid="source-sample-tab"
          [attr.aria-selected]="tab() === 'sample'"
          (click)="tab.set('sample')"
        >
          Dados de entrada
        </button>
      </div>
      <div class="panel-editor">
        @if (tab() === 'structure') {
          <mf-monaco-editor
            #structureEditor
            testId="source-editor"
            label="Editor da estrutura de origem"
            [value]="doc().source.text"
            [language]="language()"
            [errorMarker]="structureMarker()"
            (valueChange)="store.setStructureText('source', $event)"
          />
        } @else {
          <mf-monaco-editor
            testId="source-sample-editor"
            label="Editor dos dados de entrada"
            [value]="doc().sampleData"
            language="json"
            [errorMarker]="sampleMarker()"
            (valueChange)="store.setSampleData($event)"
          />
        }
      </div>
      @if (tab() === 'sample' && doc().source.format !== 'json') {
        <div class="panel-note">
          <span>Dados usados para executar o mapeamento.</span>
          <button class="btn btn-sm" type="button" (click)="store.generateSampleFromSchema()">
            Gerar da estrutura
          </button>
        </div>
      }
      @if (structureError(); as error) {
        <div class="inline-error" role="alert">
          <mf-icon name="error" [size]="14" />{{ error.message }}
        </div>
      }
      <div class="panel-search">
        <mf-icon name="search" [size]="14" />
        <input
          type="search"
          placeholder="Buscar campos"
          aria-label="Buscar campos de origem"
          data-testid="source-search"
          [value]="state.query.source()"
          (input)="state.query.source.set($any($event.target).value)"
        />
      </div>
      <div class="panel-tree">
        <mf-field-tree
          side="source"
          testPrefix="source-panel"
          [root]="store.sourceParsed().root"
          [showStatus]="true"
        />
      </div>
    </section>
  `,
})
export class SourcePanelComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly state = inject(StudioState);
  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);
  private readonly editor = viewChild<MonacoEditorComponent>('structureEditor');

  protected readonly formats = FORMAT_OPTIONS;
  protected readonly tab = signal<'structure' | 'sample'>('structure');
  protected readonly doc = this.store.document;
  protected readonly language = computed(
    () => FORMAT_OPTIONS.find((f) => f.value === this.doc().source.format)?.language ?? 'json',
  );
  protected readonly structureError = computed(() => firstError(this.store.sourceParsed().issues));
  protected readonly structureMarker = computed(() => {
    const e = this.structureError();
    return e ? { line: e.line, column: e.column, message: e.message } : null;
  });
  protected readonly sampleMarker = computed(() => {
    const s = this.store.sample();
    return s.ok ? null : { line: s.line, column: s.column, message: s.message };
  });

  protected format(): void {
    if (this.tab() === 'sample') {
      const s = this.store.sample();
      if (s.ok) this.store.setSampleData(JSON.stringify(s.value, null, 2));
      else this.toasts.error(s.message);
      return;
    }
    if (this.doc().source.format !== 'json') {
      this.toasts.info(
        'O botão Format se aplica a JSON. Use o Code Generator para gerar código formatado.',
      );
      return;
    }
    try {
      const text = JSON.stringify(JSON.parse(this.doc().source.text), null, 2);
      this.store.setStructureText('source', text);
    } catch {
      this.toasts.error(this.structureError()?.message ?? 'JSON inválido.');
    }
  }

  protected validate(): void {
    const parsed = this.store.sourceParsed();
    const error = firstError(parsed.issues);
    if (error) {
      this.toasts.error(error.message);
      if (error.line) this.editor()?.reveal(error.line, error.column);
      return;
    }
    const sample = this.store.sample();
    if (!sample.ok) {
      this.toasts.error(`Dados de entrada: ${sample.message}`);
      return;
    }
    const warnings = parsed.issues.filter((i) => i.severity === 'warning').length;
    this.toasts.success(
      warnings
        ? `Estrutura válida, com ${warnings} aviso(s) em Diagnostics.`
        : 'Estrutura e dados válidos.',
    );
  }

  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const format = formatFromFileName(file.name);
    if (!format) {
      this.toasts.error('Formato não suportado: use um arquivo .json, .java ou .ts.');
      return;
    }
    try {
      this.store.importStructure(
        'source',
        format,
        await readTextFile(file, this.settings.limits().maxBytes),
      );
      this.tab.set('structure');
      const error = firstError(this.store.sourceParsed().issues);
      if (error) this.toasts.error(error.message);
      else this.toasts.success(`${file.name} importado.`);
    } catch (e) {
      this.toasts.error(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.');
    }
  }
}
