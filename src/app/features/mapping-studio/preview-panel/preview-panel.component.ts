import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { getExample } from '../../../core/examples/examples';
import { JsonValue } from '../../../core/models/json.model';
import { flattenFields } from '../../../core/parsers/structure';
import { downloadText, ProjectStore } from '../../../core/services/project-store.service';
import { ToastService } from '../../../core/services/ui.services';
import { IconComponent } from '../../../shared/components/icon.component';
import { StudioState } from '../studio-state.service';

/** Compara valores JSON ignorando a ordem das chaves. */
export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const oa = a as { [k: string]: JsonValue };
  const ob = b as { [k: string]: JsonValue };
  return ka.length === kb.length && ka.every((k) => deepEqual(oa[k], ob[k]));
}

@Component({
  selector: 'mf-preview-panel',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preview-toolbar">
      <button class="btn btn-primary btn-sm" type="button" data-testid="run" (click)="run()">
        <mf-icon name="play" [size]="14" />Run Mapping
      </button>
      <button class="btn btn-sm" type="button" data-testid="validate" (click)="validate()">
        <mf-icon name="check" [size]="14" />Validate
      </button>
      <button class="btn btn-sm" type="button" data-testid="reset-preview" (click)="reset()">
        <mf-icon name="reset" [size]="14" />Reset
      </button>
      <button
        class="btn btn-sm"
        type="button"
        data-testid="copy-result"
        [disabled]="!result()"
        (click)="copy()"
      >
        <mf-icon name="copy" [size]="14" />Copy Result
      </button>
      <button
        class="btn btn-sm"
        type="button"
        data-testid="download-json"
        [disabled]="!result()"
        (click)="download()"
      >
        <mf-icon name="download" [size]="14" />Download JSON
      </button>
      <label class="inline-check"
        ><input
          type="checkbox"
          data-testid="auto-preview"
          [checked]="store.autoPreview()"
          (change)="toggleAuto($any($event.target).checked)"
        />Preview automático</label
      >
      <span class="spacer"></span>
      @if (store.running()) {
        <span class="muted small" role="status"><span class="spinner"></span> Executando…</span>
      }
      @if (expected(); as e) {
        <span
          class="result-check"
          [class.ok]="e.matches"
          [class.bad]="!e.matches"
          data-testid="expected-check"
        >
          <mf-icon [name]="e.matches ? 'check' : 'warning'" [size]="14" />{{
            e.matches ? 'Igual ao resultado esperado' : 'Diferente do resultado esperado'
          }}
        </span>
      }
    </div>
    @if (store.previewError(); as error) {
      <div class="inline-error" role="alert" data-testid="preview-error">
        <mf-icon name="error" [size]="14" />{{ error }}
      </div>
    }
    <div class="preview-body">
      <div class="preview-output">
        @if (result(); as r) {
          <pre class="json-output" data-testid="preview-output">{{ pretty(r.output) }}</pre>
        } @else {
          <div class="empty-state small"><p>O resultado aparece aqui depois da execução.</p></div>
        }
      </div>
      <aside class="preview-side">
        @if (result(); as r) {
          <dl class="stat-list">
            <div>
              <dt>Campos mapeados</dt>
              <dd data-testid="stat-mapped">{{ r.stats.mappedFields }}</dd>
            </div>
            <div>
              <dt>Transformações</dt>
              <dd data-testid="stat-transforms">{{ r.stats.transformations }}</dd>
            </div>
            <div>
              <dt>Tempo de execução</dt>
              <dd data-testid="stat-time">{{ r.stats.durationMs }} ms</dd>
            </div>
            <div>
              <dt>Campos ignorados</dt>
              <dd data-testid="stat-ignored">{{ r.ignored.length + unmappedSources() }}</dd>
            </div>
            <div>
              <dt>Erros de conversão</dt>
              <dd data-testid="stat-conversion">{{ r.stats.conversionErrors }}</dd>
            </div>
          </dl>
          @if (r.issues.length) {
            <h3>Erros e avisos</h3>
            <ul class="issue-list" data-testid="preview-issues">
              @for (issue of r.issues; track $index) {
                <li [class]="'issue-' + issue.severity">
                  <button type="button" class="link-row" (click)="focus(issue.mappingId)">
                    <mf-icon
                      [name]="
                        issue.severity === 'error'
                          ? 'error'
                          : issue.severity === 'warning'
                            ? 'warning'
                            : 'info'
                      "
                      [size]="13"
                    />
                    <span>{{ issue.message }}</span>
                  </button>
                </li>
              }
            </ul>
          }
          @if (r.ignored.length) {
            <h3>Ignorados</h3>
            <ul class="issue-list">
              @for (item of r.ignored; track $index) {
                <li class="issue-info">
                  <span class="mono">{{ item.path }}</span
                  >: {{ item.reason }}
                </li>
              }
            </ul>
          }
        }
      </aside>
    </div>
  `,
})
export class PreviewPanelComponent {
  protected readonly store = inject(ProjectStore);
  private readonly state = inject(StudioState);
  private readonly toasts = inject(ToastService);
  protected readonly result = this.store.preview;

  /** Campos de origem com valor que nenhum mapeamento usa. */
  protected readonly unmappedSources = computed(() => {
    const mapped = this.store.mappedSources();
    return flattenFields(this.store.sourceParsed().root).filter(
      (f) =>
        !f.children?.length &&
        !mapped.has(f.path) &&
        ![...mapped].some((p) => f.path.startsWith(`${p}.`) || f.path.startsWith(`${p}[`)),
    ).length;
  });

  protected readonly expected = computed(() => {
    const id = this.store.project().exampleId;
    const r = this.result();
    if (!id || !r) return null;
    const example = getExample(id);
    return example ? { matches: deepEqual(r.output, example.expectedOutput) } : null;
  });

  protected pretty(value: JsonValue): string {
    return JSON.stringify(value, null, 2);
  }

  protected async run(): Promise<void> {
    const r = await this.store.runMapping();
    if (!r) return;
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    if (errors) this.toasts.warning(`Execução concluída com ${errors} erro(s).`);
    else this.toasts.success(`Execução concluída: ${r.stats.mappedFields} campos mapeados.`);
  }

  protected validate(): void {
    const all = this.store.diagnostics();
    const errors = all.filter((d) => d.severity === 'error').length;
    const warnings = all.filter((d) => d.severity === 'warning').length;
    if (errors) this.toasts.error(`${errors} erro(s) e ${warnings} aviso(s) encontrados.`);
    else if (warnings) this.toasts.warning(`Sem erros, com ${warnings} aviso(s).`);
    else this.toasts.success('Nenhum problema encontrado.');
    this.state.showDock('diagnostics');
  }

  protected reset(): void {
    this.store.preview.set(null);
    this.store.previewError.set(null);
  }

  protected async copy(): Promise<void> {
    const r = this.result();
    if (!r) return;
    try {
      await navigator.clipboard.writeText(this.pretty(r.output));
      this.toasts.success('Resultado copiado.');
    } catch {
      this.toasts.error('O navegador não permitiu copiar.');
    }
  }

  protected download(): void {
    const r = this.result();
    if (r) downloadText('resultado.json', this.pretty(r.output));
  }

  protected toggleAuto(enabled: boolean): void {
    this.store.autoPreview.set(enabled);
    if (enabled) void this.store.execute();
  }

  protected focus(mappingId: string | undefined): void {
    if (mappingId) this.store.selectedMappingId.set(mappingId);
  }
}
