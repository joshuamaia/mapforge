import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { EXAMPLES, ExampleDefinition } from '../../core/examples/examples';
import { ProjectStore } from '../../core/services/project-store.service';
import { IconComponent } from '../../shared/components/icon.component';
import { StudioState } from '../mapping-studio/studio-state.service';

@Component({
  selector: 'mf-examples',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Examples</h1>
          <p class="muted">
            Cada exemplo traz dados de entrada, estrutura de destino e mapeamentos prontos para
            executar.
          </p>
        </div>
      </header>
      <div class="card-grid">
        @for (e of examples; track e.id) {
          <article class="card example-card" [attr.data-testid]="'example-' + e.id">
            <div class="example-number">{{ e.number }}</div>
            <h2>{{ e.title }}</h2>
            <p class="muted">{{ e.description }}</p>
            <ul class="tag-list">
              @for (h of e.highlights; track h) {
                <li>{{ h }}</li>
              }
            </ul>
            <p class="muted small">
              {{ e.document.mappings.length }} mapeamentos · {{ formatLabel(e) }}
            </p>
            <div class="card-actions">
              <button
                class="btn btn-primary btn-sm"
                type="button"
                [attr.data-testid]="'open-example-' + e.id"
                (click)="open(e)"
              >
                <mf-icon name="play" [size]="14" />Abrir e executar
              </button>
              <button
                class="btn btn-sm"
                type="button"
                [attr.aria-expanded]="expanded() === e.id"
                (click)="expanded.set(expanded() === e.id ? null : e.id)"
              >
                Resultado esperado
              </button>
            </div>
            @if (expanded() === e.id) {
              <pre class="json-output example-output">{{ pretty(e.expectedOutput) }}</pre>
            }
          </article>
        }
      </div>
    </div>
  `,
})
export class ExamplesComponent {
  private readonly store = inject(ProjectStore);
  private readonly router = inject(Router);
  private readonly state = inject(StudioState);
  protected readonly examples = EXAMPLES;
  protected readonly expanded = signal<string | null>(null);

  protected formatLabel(e: ExampleDefinition): string {
    const names = { json: 'JSON', java: 'Java', typescript: 'TypeScript' };
    return `${names[e.document.source.format]} para ${names[e.document.target.format]}`;
  }

  protected pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  protected async open(example: ExampleDefinition): Promise<void> {
    if (!(await this.store.openExample(example))) return;
    this.state.showDock(example.id === 'erros' ? 'diagnostics' : 'preview');
    await this.router.navigateByUrl('/studio');
    await this.store.execute();
  }
}
