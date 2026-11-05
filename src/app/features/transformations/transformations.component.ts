import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { JsonValue } from '../../core/models/json.model';
import { TransformParams } from '../../core/models/mapping.model';
import { runPipeline } from '../../core/mapping-engine/pipeline';
import { ProjectStore } from '../../core/services/project-store.service';
import { ToastService } from '../../core/services/ui.services';
import {
  CATEGORY_LABELS,
  TransformCategory,
  TransformDefinition,
  TRANSFORMS,
  validateStep,
} from '../../core/transformations/catalog';
import { IconComponent } from '../../shared/components/icon.component';
import { ParamFormComponent } from '../../shared/components/param-form.component';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as TransformCategory[];

@Component({
  selector: 'mf-transformations',
  imports: [IconComponent, ParamFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page page-split">
      <div class="catalog">
        <header class="page-header">
          <div>
            <h1>Transformations</h1>
            <p class="muted">
              Catálogo com {{ all.length }} transformações. Escolha uma para configurar e ver o
              resultado.
            </p>
          </div>
        </header>
        <div class="toolbar">
          <div class="panel-search inline">
            <mf-icon name="search" [size]="14" />
            <input
              type="search"
              placeholder="Buscar transformação"
              aria-label="Buscar transformação"
              data-testid="catalog-search"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          </div>
        </div>
        @for (group of groups(); track group.category) {
          <h2 class="section-title">{{ group.label }}</h2>
          <div class="catalog-grid">
            @for (t of group.items; track t.id) {
              <button
                type="button"
                class="catalog-card"
                [class.selected]="selected().id === t.id"
                [attr.aria-pressed]="selected().id === t.id"
                [attr.data-testid]="'catalog-' + t.id"
                (click)="choose(t)"
              >
                <strong>{{ t.label }}</strong>
                <span>{{ t.description }}</span>
              </button>
            }
          </div>
        } @empty {
          <div class="empty-state"><p>Nenhuma transformação encontrada.</p></div>
        }
      </div>
      <aside class="playground" aria-label="Configuração e prévia da transformação">
        <h2>{{ selected().label }}</h2>
        <p class="muted small">{{ selected().description }}</p>
        <div class="field">
          <label for="playground-input">Valor de entrada (JSON ou texto)</label>
          <textarea
            id="playground-input"
            rows="4"
            class="mono"
            spellcheck="false"
            data-testid="playground-input"
            [value]="inputText()"
            (input)="inputText.set($any($event.target).value)"
          ></textarea>
        </div>
        <h3>Configuração</h3>
        <mf-param-form
          idPrefix="playground"
          [definition]="selected()"
          [params]="params()"
          (paramsChange)="params.set($event)"
        />
        <h3>Prévia do resultado</h3>
        @if (configErrors().length) {
          @for (e of configErrors(); track e) {
            <p class="inline-error small"><mf-icon name="error" [size]="13" />{{ e }}</p>
          }
        }
        <pre class="json-output playground-output" data-testid="playground-output">{{
          output()
        }}</pre>
        @if (runtimeError(); as e) {
          <p class="inline-error small" data-testid="playground-error">
            <mf-icon name="error" [size]="13" />{{ e }}
          </p>
        }
        @if (store.selectedMapping(); as m) {
          <button class="btn btn-sm" type="button" data-testid="catalog-add" (click)="add(m.id)">
            <mf-icon name="plus" [size]="14" />Adicionar a {{ m.targetPath }}
          </button>
        } @else {
          <p class="muted small">
            Selecione uma conexão no Mapping Studio para adicionar esta transformação a ela.
          </p>
        }
      </aside>
    </div>
  `,
})
export class TransformationsComponent {
  protected readonly store = inject(ProjectStore);
  private readonly toasts = inject(ToastService);
  protected readonly all = TRANSFORMS;
  protected readonly query = signal('');
  protected readonly selected = signal<TransformDefinition>(TRANSFORMS[0]);
  protected readonly params = signal<TransformParams>(TRANSFORMS[0].sample.params);
  protected readonly inputText = signal(asText(TRANSFORMS[0].sample.input));

  protected readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    return CATEGORIES.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      items: TRANSFORMS.filter(
        (t) =>
          t.category === category &&
          (!q || `${t.label} ${t.id} ${t.description}`.toLowerCase().includes(q)),
      ),
    })).filter((g) => g.items.length > 0);
  });

  private readonly step = computed(() => ({
    id: 'playground',
    transformId: this.selected().id,
    params: this.params(),
  }));
  protected readonly configErrors = computed(() => validateStep(this.step()));
  private readonly result = computed(() => {
    let input: JsonValue;
    const text = this.inputText();
    try {
      input = JSON.parse(text) as JsonValue;
    } catch {
      input = text;
    }
    if (this.configErrors().length) return null;
    try {
      return runPipeline(input, [this.step()]);
    } catch (e) {
      return {
        value: undefined,
        errors: [e instanceof Error ? e.message : String(e)],
        trace: [],
        runs: 0,
      };
    }
  });
  protected readonly output = computed(() => {
    const r = this.result();
    if (!r) return '—';
    return r.value === undefined ? '(campo omitido)' : JSON.stringify(r.value, null, 2);
  });
  protected readonly runtimeError = computed(() => this.result()?.errors[0] ?? null);

  protected choose(t: TransformDefinition): void {
    this.selected.set(t);
    this.params.set(t.sample.params);
    this.inputText.set(asText(t.sample.input));
  }

  protected add(mappingId: string): void {
    const def = this.selected();
    this.store.addStep(mappingId, def.id);
    const mapping = this.store.document().mappings.find((m) => m.id === mappingId);
    const step = mapping?.transforms[mapping.transforms.length - 1];
    if (step) this.store.updateStep(mappingId, step.id, { params: this.params() });
    this.toasts.success(`${def.label} adicionada.`);
  }
}

function asText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
