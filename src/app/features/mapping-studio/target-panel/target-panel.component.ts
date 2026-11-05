import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FieldType } from '../../../core/models/schema.model';
import { ProjectStore, readTextFile } from '../../../core/services/project-store.service';
import { SettingsService } from '../../../core/services/settings.service';
import { ToastService } from '../../../core/services/ui.services';
import { flattenFields } from '../../../core/parsers/structure';
import { FieldTreeComponent } from '../../../shared/components/field-tree.component';
import { IconComponent } from '../../../shared/components/icon.component';
import { MonacoEditorComponent } from '../../../shared/components/monaco-editor.component';
import { TooltipDirective } from '../../../shared/directives/tooltip.directive';
import {
  firstError,
  FORMAT_OPTIONS,
  formatFromFileName,
} from '../source-panel/source-panel.component';
import { StudioState } from '../studio-state.service';

const TYPES: FieldType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'object',
  'array',
  'any',
];

@Component({
  selector: 'mf-target-panel',
  imports: [IconComponent, MonacoEditorComponent, FieldTreeComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-labelledby="target-title">
      <header class="panel-header">
        <h2 id="target-title">Target</h2>
        <select
          class="select-sm"
          aria-label="Formato do destino"
          data-testid="target-format"
          [value]="doc().target.format"
          (change)="store.setStructureFormat('target', $any($event.target).value)"
        >
          @for (o of formats; track o.value) {
            <option [value]="o.value" [selected]="o.value === doc().target.format">
              {{ o.label }}
            </option>
          }
        </select>
        <span class="spacer"></span>
        <span
          class="count-chip"
          data-testid="target-coverage"
          mfTooltip="Campos de destino mapeados"
          >{{ coverage().mapped }}/{{ coverage().total }}</span
        >
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
          aria-label="Importar arquivo de destino"
          data-testid="target-file"
          (change)="importFile($event)"
        />
      </header>
      <div class="tabs tabs-sm" role="tablist" aria-label="Conteúdo do destino">
        <button
          role="tab"
          type="button"
          [attr.aria-selected]="tab() === 'structure'"
          (click)="tab.set('structure')"
        >
          Estrutura
        </button>
        <button
          role="tab"
          type="button"
          data-testid="target-props-tab"
          [attr.aria-selected]="tab() === 'properties'"
          (click)="tab.set('properties')"
        >
          Propriedades
        </button>
        <button
          role="tab"
          type="button"
          data-testid="target-preview-tab"
          [attr.aria-selected]="tab() === 'preview'"
          (click)="tab.set('preview')"
        >
          Preview
        </button>
      </div>
      @switch (tab()) {
        @case ('structure') {
          <div class="panel-editor">
            <mf-monaco-editor
              testId="target-editor"
              label="Editor da estrutura de destino"
              [value]="doc().target.text"
              [language]="language()"
              [errorMarker]="marker()"
              (valueChange)="store.setStructureText('target', $event)"
            />
          </div>
          @if (error(); as e) {
            <div class="inline-error" role="alert">
              <mf-icon name="error" [size]="14" />{{ e.message }}
            </div>
          }
          <div class="panel-search">
            <mf-icon name="search" [size]="14" />
            <input
              type="search"
              placeholder="Buscar campos"
              aria-label="Buscar campos de destino"
              [value]="state.query.target()"
              (input)="state.query.target.set($any($event.target).value)"
            />
          </div>
          <div class="panel-tree">
            <mf-field-tree
              side="target"
              testPrefix="target-panel"
              [root]="store.targetParsed().root"
              [showStatus]="true"
            />
          </div>
        }
        @case ('properties') {
          <div class="panel-scroll">
            <table class="table table-compact">
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Tipo</th>
                  <th>Obrig.</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (f of fields(); track f.path) {
                  <tr>
                    <td class="mono wrap">{{ f.path }}</td>
                    <td>
                      <select
                        class="select-sm"
                        [attr.aria-label]="'Tipo de ' + f.path"
                        (change)="setType(f.path, $any($event.target).value)"
                      >
                        @for (t of types; track t) {
                          <option [value]="t" [selected]="t === f.type">{{ t }}</option>
                        }
                      </select>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        [attr.aria-label]="'Obrigatório: ' + f.path"
                        [attr.data-testid]="'required-' + f.path"
                        [checked]="f.required"
                        (change)="
                          store.setOverride('target', f.path, {
                            required: $any($event.target).checked,
                          })
                        "
                      />
                    </td>
                    <td>
                      <span
                        class="map-state"
                        [class.on]="store.mappedTargets().has(f.path)"
                        [title]="store.mappedTargets().has(f.path) ? 'Mapeado' : 'Não mapeado'"
                      ></span>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="4" class="muted">Nenhum campo.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @case ('preview') {
          <div class="panel-scroll">
            @if (store.preview(); as result) {
              <pre class="json-output" data-testid="target-preview">{{
                pretty(result.output)
              }}</pre>
            } @else {
              <div class="empty-state small">
                <p>{{ store.previewError() ?? 'Execute o mapeamento para ver o resultado.' }}</p>
              </div>
            }
          </div>
        }
      }
    </section>
  `,
})
export class TargetPanelComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly state = inject(StudioState);
  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);
  protected readonly formats = FORMAT_OPTIONS;
  protected readonly types = TYPES;
  protected readonly tab = signal<'structure' | 'properties' | 'preview'>('structure');
  protected readonly doc = this.store.document;
  protected readonly language = computed(
    () => FORMAT_OPTIONS.find((f) => f.value === this.doc().target.format)?.language ?? 'json',
  );
  protected readonly error = computed(() => firstError(this.store.targetParsed().issues));
  protected readonly marker = computed(() => {
    const e = this.error();
    return e ? { line: e.line, column: e.column, message: e.message } : null;
  });
  protected readonly fields = computed(() =>
    flattenFields(this.store.targetParsed().root).filter((f) => f.name !== '[*]'),
  );
  protected readonly coverage = computed(() => {
    const leaves = this.fields().filter((f) => !f.children?.length || f.children[0].name === '[*]');
    const mapped = this.store.mappedTargets();
    return {
      total: leaves.length,
      mapped: leaves.filter((f) => mapped.has(f.path) || mapped.has(`${f.path}[*]`)).length,
    };
  });

  protected pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  protected setType(path: string, type: FieldType): void {
    this.store.setOverride('target', path, { type });
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
        'target',
        format,
        await readTextFile(file, this.settings.limits().maxBytes),
      );
      const error = firstError(this.store.targetParsed().issues);
      if (error) this.toasts.error(error.message);
      else this.toasts.success(`${file.name} importado.`);
    } catch (e) {
      this.toasts.error(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.');
    }
  }
}
