import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { JsonValue } from '../../../core/models/json.model';
import {
  ArrayScope,
  Condition,
  ConditionOperator,
  Mapping,
} from '../../../core/models/mapping.model';
import { StepTrace } from '../../../core/models/execution.model';
import { isValidPath, wildcardPrefixes } from '../../../core/mapping-engine/path';
import { ProjectStore } from '../../../core/services/project-store.service';
import {
  CATEGORY_LABELS,
  getTransform,
  TransformCategory,
  TransformDefinition,
  TRANSFORMS,
  validateStep,
} from '../../../core/transformations/catalog';
import { OPERATORS } from '../../../core/transformations/values';
import { IconComponent } from '../../../shared/components/icon.component';
import {
  formatLiteral,
  ParamFormComponent,
  parseLiteral,
} from '../../../shared/components/param-form.component';
import { StudioState } from '../studio-state.service';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as TransformCategory[];

/** Valor em texto curto, para a coluna de entrada e saída das etapas. */
export function showValue(value: JsonValue | undefined): string {
  if (value === undefined) return '(ausente)';
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

@Component({
  selector: 'mf-mapping-properties',
  imports: [IconComponent, ParamFormComponent, CdkDropList, CdkDrag, CdkDragHandle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mapping(); as m) {
      <div class="props-grid">
        <div class="props-col">
          <h3>Conexão</h3>
          <div class="field">
            <label for="prop-source"
              >Origem
              <span class="type-badge" [class]="'type-badge type-' + m.sourceType">{{
                m.sourceType
              }}</span></label
            >
            <input
              id="prop-source"
              class="mono"
              data-testid="prop-source"
              spellcheck="false"
              [value]="m.sourcePath"
              placeholder="(sem origem)"
              (change)="setPath(m, 'sourcePath', $any($event.target).value)"
            />
          </div>
          <div class="field">
            <label for="prop-target"
              >Destino
              <span class="type-badge" [class]="'type-badge type-' + m.targetType">{{
                m.targetType
              }}</span></label
            >
            <input
              id="prop-target"
              class="mono"
              data-testid="prop-target"
              spellcheck="false"
              [value]="m.targetPath"
              (change)="setPath(m, 'targetPath', $any($event.target).value)"
            />
          </div>
          <div class="field">
            <label for="prop-default">Valor padrão</label>
            <input
              id="prop-default"
              data-testid="prop-default"
              spellcheck="false"
              placeholder="Usado quando o resultado é nulo"
              [value]="defaultText(m)"
              (input)="setDefault(m, $any($event.target).value)"
            />
          </div>
          <div class="row-between">
            <span class="status-line" [class]="'status-line status-' + m.validationStatus">{{
              statusLabel(m)
            }}</span>
            <button
              class="btn btn-sm btn-danger-ghost"
              type="button"
              data-testid="remove-connection"
              (click)="store.removeMapping(m.id)"
            >
              <mf-icon name="trash" [size]="14" />Remover conexão
            </button>
          </div>

          <h3>Condições</h3>
          @for (c of m.conditions ?? []; track $index; let i = $index) {
            <div class="condition-row">
              <input
                class="mono"
                spellcheck="false"
                aria-label="Campo da condição"
                [value]="c.field"
                (change)="patchCondition(m, i, { field: $any($event.target).value })"
              />
              <select
                aria-label="Operador"
                (change)="patchCondition(m, i, { operator: $any($event.target).value })"
              >
                @for (o of operators; track o.id) {
                  <option [value]="o.id" [selected]="o.id === c.operator">{{ o.label }}</option>
                }
              </select>
              <input
                spellcheck="false"
                aria-label="Valor da condição"
                [value]="literal(c.value)"
                (input)="patchCondition(m, i, { value: parse($any($event.target).value) })"
              />
              <button
                class="btn-icon"
                type="button"
                aria-label="Remover condição"
                (click)="removeCondition(m, i)"
              >
                <mf-icon name="close" [size]="14" />
              </button>
            </div>
          } @empty {
            <p class="muted small">Sem condições: o mapeamento vale sempre.</p>
          }
          <button
            class="btn btn-sm"
            type="button"
            data-testid="add-condition"
            (click)="addCondition(m)"
          >
            <mf-icon name="plus" [size]="14" />Adicionar condição
          </button>

          @for (pair of scopesFor(m); track pair.key) {
            <h3>Linhas de {{ pair.sourcePath }}</h3>
            <p class="muted small">
              Vale para todos os campos desse array: as linhas continuam alinhadas.
            </p>
            <div class="condition-row">
              <input
                class="mono"
                spellcheck="false"
                aria-label="Campo do filtro"
                placeholder="filtrar por campo"
                [attr.data-testid]="'scope-filter-field-' + pair.targetPath"
                [value]="pair.scope?.filter?.[0]?.field ?? ''"
                (change)="setScopeFilter(pair, { field: $any($event.target).value })"
              />
              <select
                aria-label="Operador do filtro"
                (change)="setScopeFilter(pair, { operator: $any($event.target).value })"
              >
                @for (o of operators; track o.id) {
                  <option
                    [value]="o.id"
                    [selected]="o.id === (pair.scope?.filter?.[0]?.operator ?? 'eq')"
                  >
                    {{ o.label }}
                  </option>
                }
              </select>
              <input
                spellcheck="false"
                aria-label="Valor do filtro"
                placeholder="valor"
                [attr.data-testid]="'scope-filter-value-' + pair.targetPath"
                [value]="literal(pair.scope?.filter?.[0]?.value)"
                (change)="setScopeFilter(pair, { value: parse($any($event.target).value) })"
              />
            </div>
            <div class="condition-row">
              <input
                class="mono"
                spellcheck="false"
                aria-label="Ordenar por campo"
                placeholder="ordenar por campo"
                [value]="pair.scope?.sort?.field ?? ''"
                (change)="
                  setScopeSort(
                    pair,
                    $any($event.target).value,
                    pair.scope?.sort?.direction ?? 'asc'
                  )
                "
              />
              <select
                aria-label="Direção da ordenação"
                (change)="
                  setScopeSort(pair, pair.scope?.sort?.field ?? '', $any($event.target).value)
                "
              >
                <option value="asc" [selected]="pair.scope?.sort?.direction !== 'desc'">
                  Crescente
                </option>
                <option value="desc" [selected]="pair.scope?.sort?.direction === 'desc'">
                  Decrescente
                </option>
              </select>
              <input
                class="mono"
                spellcheck="false"
                aria-label="Distinct por campo"
                placeholder="distinct por campo"
                [value]="pair.scope?.distinctBy ?? ''"
                (change)="setScopeDistinct(pair, $any($event.target).value)"
              />
            </div>
          }
        </div>

        <div class="props-col props-col-wide">
          <div class="row-between">
            <h3>Transformações</h3>
            <select
              class="select-sm"
              aria-label="Adicionar transformação"
              data-testid="add-transform"
              (change)="addStep(m, $event)"
            >
              <option value="">Adicionar…</option>
              @for (group of groups; track group.category) {
                <optgroup [label]="group.label">
                  @for (t of group.items; track t.id) {
                    <option [value]="t.id">{{ t.label }}</option>
                  }
                </optgroup>
              }
            </select>
          </div>
          <div cdkDropList class="step-list" (cdkDropListDropped)="drop(m, $event)">
            @for (step of m.transforms; track step.id; let i = $index) {
              <article
                class="step-card"
                cdkDrag
                cdkDragLockAxis="y"
                [class.disabled]="step.disabled"
                [attr.data-testid]="'step-' + step.transformId"
              >
                <header class="step-header">
                  <button
                    class="btn-icon drag-handle"
                    type="button"
                    cdkDragHandle
                    aria-label="Arrastar para reordenar"
                  >
                    <mf-icon name="grip" [size]="14" />
                  </button>
                  <span class="step-index">{{ i + 1 }}</span>
                  <strong>{{ def(step.transformId)?.label ?? step.transformId }}</strong>
                  <span class="spacer"></span>
                  <label class="inline-check"
                    ><input
                      type="checkbox"
                      [checked]="!step.disabled"
                      (change)="
                        store.updateStep(m.id, step.id, { disabled: !$any($event.target).checked })
                      "
                    />Ativa</label
                  >
                  <button
                    class="btn-icon"
                    type="button"
                    aria-label="Subir etapa"
                    [disabled]="i === 0"
                    (click)="store.moveStep(m.id, i, i - 1)"
                  >
                    <mf-icon name="chevronDown" [size]="14" class="flip" />
                  </button>
                  <button
                    class="btn-icon"
                    type="button"
                    aria-label="Descer etapa"
                    [disabled]="i === m.transforms.length - 1"
                    (click)="store.moveStep(m.id, i, i + 1)"
                  >
                    <mf-icon name="chevronDown" [size]="14" />
                  </button>
                  <button
                    class="btn-icon"
                    type="button"
                    aria-label="Remover etapa"
                    (click)="store.removeStep(m.id, step.id)"
                  >
                    <mf-icon name="trash" [size]="14" />
                  </button>
                </header>
                @if (def(step.transformId); as definition) {
                  @if (definition.params.length) {
                    <mf-param-form
                      [definition]="definition"
                      [params]="step.params"
                      [idPrefix]="step.id"
                      (paramsChange)="store.updateStep(m.id, step.id, { params: $event })"
                    />
                  }
                }
                @for (error of stepErrors(step); track error) {
                  <p class="inline-error small"><mf-icon name="error" [size]="13" />{{ error }}</p>
                }
                @if (traceOf(m, step.id); as t) {
                  <dl class="trace" [attr.data-testid]="'trace-' + step.transformId">
                    <dt>Entrada</dt>
                    <dd class="mono">{{ show(t.input) }}</dd>
                    <dt>Saída</dt>
                    <dd class="mono">{{ show(t.output) }}</dd>
                    @if (t.error) {
                      <dt>Erro</dt>
                      <dd class="text-error">{{ t.error }}</dd>
                    }
                  </dl>
                }
              </article>
            } @empty {
              <div class="empty-state small">
                <p>
                  Sem transformações: o valor é copiado como está. Adicione etapas para convertê-lo;
                  cada uma mostra a entrada e a saída.
                </p>
              </div>
            }
          </div>
        </div>
      </div>
    } @else {
      <div class="empty-state">
        <mf-icon name="studio" [size]="28" />
        <p>Selecione uma conexão no canvas para ver as propriedades.</p>
      </div>
    }
  `,
})
export class MappingPropertiesComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly state = inject(StudioState);
  protected readonly mapping = this.store.selectedMapping;
  protected readonly operators = OPERATORS;
  protected readonly show = showValue;
  protected readonly literal = formatLiteral;
  protected readonly parse = parseLiteral;
  protected readonly groups = CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: TRANSFORMS.filter((t) => t.category === category),
  }));

  private readonly traces = computed(() => this.store.preview()?.traces ?? {});

  protected def(id: string): TransformDefinition | undefined {
    return getTransform(id);
  }

  protected traceOf(m: Mapping, stepId: string): StepTrace | undefined {
    return this.traces()[m.id]?.find((t) => t.stepId === stepId);
  }

  protected stepErrors(step: Mapping['transforms'][number]): string[] {
    return step.disabled ? [] : validateStep(step);
  }

  protected statusLabel(m: Mapping): string {
    switch (m.validationStatus) {
      case 'error':
        return 'Com erro: veja Diagnostics';
      case 'warning':
        return 'Com aviso: veja Diagnostics';
      case 'valid':
        return 'Válido';
      default:
        return 'Não validado';
    }
  }

  protected defaultText(m: Mapping): string {
    return formatLiteral(m.defaultValue);
  }

  protected setDefault(m: Mapping, text: string): void {
    const value = parseLiteral(text);
    const { defaultValue: _removed, ...rest } = m;
    void _removed;
    this.store.updateDocument(
      (doc) => ({
        ...doc,
        mappings: doc.mappings.map((x) =>
          x.id === m.id ? (value === undefined ? { ...rest } : { ...x, defaultValue: value }) : x,
        ),
      }),
      `default:${m.id}`,
    );
  }

  protected setPath(m: Mapping, key: 'sourcePath' | 'targetPath', value: string): void {
    const path = value.trim();
    if (path !== '' && !isValidPath(path)) {
      // O diagnóstico mostra o problema; o texto não é descartado.
      this.store.updateMapping(m.id, { [key]: path });
      return;
    }
    const fields = key === 'sourcePath' ? this.store.sourceFields() : this.store.targetFields();
    const typeKey = key === 'sourcePath' ? 'sourceType' : 'targetType';
    this.store.updateMapping(m.id, { [key]: path, [typeKey]: fields.get(path)?.type ?? 'any' });
  }

  protected addStep(m: Mapping, event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.value) this.store.addStep(m.id, select.value);
    select.value = '';
  }

  protected drop(m: Mapping, event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex)
      this.store.moveStep(m.id, event.previousIndex, event.currentIndex);
  }

  protected addCondition(m: Mapping): void {
    const condition: Condition = { field: m.sourcePath, operator: 'exists' };
    this.store.updateMapping(m.id, { conditions: [...(m.conditions ?? []), condition] });
  }

  protected patchCondition(m: Mapping, index: number, patch: Partial<Condition>): void {
    const conditions = (m.conditions ?? []).map((c, i) => (i === index ? { ...c, ...patch } : c));
    this.store.updateMapping(m.id, { conditions }, `cond:${m.id}:${index}`);
  }

  protected removeCondition(m: Mapping, index: number): void {
    const conditions = (m.conditions ?? []).filter((_, i) => i !== index);
    this.store.updateMapping(m.id, { conditions: conditions.length ? conditions : undefined });
  }

  // ------------------------------------------------------------------ escopos

  protected scopesFor(
    m: Mapping,
  ): { key: string; sourcePath: string; targetPath: string; scope?: ArrayScope }[] {
    let sp: string[];
    let tp: string[];
    try {
      sp = wildcardPrefixes(m.sourcePath);
      tp = wildcardPrefixes(m.targetPath);
    } catch {
      return [];
    }
    const scopes = this.store.document().scopes;
    return sp.slice(0, tp.length).map((sourcePath, i) => ({
      key: `${sourcePath}=>${tp[i]}`,
      sourcePath,
      targetPath: tp[i],
      scope: scopes.find((s) => s.sourcePath === sourcePath && s.targetPath === tp[i]),
    }));
  }

  protected setScopeFilter(
    pair: { sourcePath: string; targetPath: string; scope?: ArrayScope },
    patch: { field?: string; operator?: ConditionOperator; value?: JsonValue },
  ): void {
    const current = pair.scope?.filter?.[0] ?? { field: '', operator: 'eq' as ConditionOperator };
    const next = { ...current, ...patch };
    this.store.upsertScope(pair.sourcePath, pair.targetPath, {
      filter: next.field ? [next] : undefined,
    });
  }

  protected setScopeSort(
    pair: { sourcePath: string; targetPath: string },
    field: string,
    direction: 'asc' | 'desc',
  ): void {
    this.store.upsertScope(pair.sourcePath, pair.targetPath, {
      sort: field ? { field, direction } : undefined,
    });
  }

  protected setScopeDistinct(
    pair: { sourcePath: string; targetPath: string },
    field: string,
  ): void {
    this.store.upsertScope(pair.sourcePath, pair.targetPath, { distinctBy: field || undefined });
  }
}
