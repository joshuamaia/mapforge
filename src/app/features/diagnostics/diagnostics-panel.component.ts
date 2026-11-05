import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Diagnostic, DiagnosticSeverity } from '../../core/models/diagnostic.model';
import { ProjectStore } from '../../core/services/project-store.service';
import { IconComponent } from '../../shared/components/icon.component';

const LABELS: Record<DiagnosticSeverity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};

@Component({
  selector: 'mf-diagnostics-panel',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preview-toolbar">
      <h3 class="inline-title">Mapping Diagnostics</h3>
      @for (s of severities; track s) {
        <button
          class="filter-chip"
          type="button"
          [attr.aria-pressed]="filter().has(s)"
          [attr.data-testid]="'filter-' + s"
          (click)="toggle(s)"
        >
          <mf-icon [name]="s" [size]="13" />{{ labels[s] }} <strong>{{ count(s) }}</strong>
        </button>
      }
    </div>
    @if (visible().length) {
      <ul class="diagnostic-list" data-testid="diagnostics">
        @for (d of visible(); track d.id) {
          <li>
            <button
              type="button"
              class="diagnostic"
              [class]="'diagnostic diagnostic-' + d.severity"
              [class.selected]="d.mappingId && d.mappingId === store.selectedMappingId()"
              [attr.data-code]="d.code"
              (click)="open(d)"
            >
              <mf-icon [name]="d.severity" [size]="15" />
              <span class="diagnostic-body">
                <span class="diagnostic-head"
                  ><span class="severity-label">{{ labels[d.severity] }}</span
                  ><code>{{ d.field }}</code></span
                >
                <span>{{ d.message }}</span>
                <span class="muted">Sugestão: {{ d.suggestion }}</span>
              </span>
            </button>
          </li>
        }
      </ul>
    } @else {
      <div class="empty-state small">
        <mf-icon name="check" [size]="24" />
        <p>
          {{
            store.diagnostics().length
              ? 'Nenhum diagnóstico com esse filtro.'
              : 'Nenhum problema encontrado no mapeamento.'
          }}
        </p>
      </div>
    }
  `,
})
export class DiagnosticsPanelComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly labels = LABELS;
  protected readonly severities: DiagnosticSeverity[] = ['error', 'warning', 'info'];
  protected readonly filter = signal<ReadonlySet<DiagnosticSeverity>>(new Set(this.severities));
  protected readonly visible = computed(() =>
    this.store.diagnostics().filter((d) => this.filter().has(d.severity)),
  );

  protected count(s: DiagnosticSeverity): number {
    return this.store.diagnostics().filter((d) => d.severity === s).length;
  }

  protected toggle(s: DiagnosticSeverity): void {
    this.filter.update((set) => {
      const next = new Set(set);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  /** Destaca a conexão no canvas ou, sem conexão associada, o campo na árvore. */
  protected open(d: Diagnostic): void {
    if (d.mappingId) {
      this.store.selectedMappingId.set(d.mappingId);
      this.store.highlightedPath.set(null);
    } else {
      this.store.selectedMappingId.set(null);
      this.store.highlightedPath.set({
        side: this.store.targetFields().has(d.field) ? 'target' : 'source',
        path: d.field,
      });
    }
  }
}
