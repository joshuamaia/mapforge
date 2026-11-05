import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ExecutionRecord } from '../../core/models/project.model';
import { Mapping } from '../../core/models/mapping.model';
import { ProjectStore } from '../../core/services/project-store.service';
import { ConfirmService, ToastService } from '../../core/services/ui.services';
import { ConfidenceLevel } from '../../core/smart-mapping/smart-mapping';
import { getTransform } from '../../core/transformations/catalog';
import { IconComponent } from '../../shared/components/icon.component';
import { StudioState } from './studio-state.service';

const LEVEL_LABEL: Record<ConfidenceLevel, string> = {
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

@Component({
  selector: 'mf-mappings-list',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preview-toolbar">
      <div class="panel-search inline">
        <mf-icon name="search" [size]="14" />
        <input
          type="search"
          placeholder="Filtrar por campo"
          aria-label="Filtrar mapeamentos por campo"
          data-testid="mapping-filter"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
      <select
        class="select-sm"
        aria-label="Filtrar mapeamentos por situação"
        data-testid="mapping-status-filter"
        (change)="status.set($any($event.target).value)"
      >
        <option value="all">Todas as situações</option>
        <option value="valid">Válidos</option>
        <option value="warning">Com aviso</option>
        <option value="error">Com erro</option>
        <option value="transformed">Com transformação</option>
      </select>
      <span class="muted small">{{ filtered().length }} de {{ store.mappings().length }}</span>
      <span class="spacer"></span>
      <button
        class="btn btn-sm btn-danger-ghost"
        type="button"
        [disabled]="store.mappings().length === 0"
        (click)="clear()"
      >
        <mf-icon name="trash" [size]="14" />Remover todos
      </button>
    </div>
    @if (filtered().length) {
      <table class="table table-compact" data-testid="mapping-table">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Destino</th>
            <th>Transformações</th>
            <th>Situação</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (m of filtered(); track m.id) {
            <tr [class.selected]="m.id === store.selectedMappingId()" (click)="open(m)">
              <td class="mono wrap">{{ m.sourcePath || '(sem origem)' }}</td>
              <td class="mono wrap">{{ m.targetPath }}</td>
              <td>{{ steps(m) }}</td>
              <td>
                <span class="status-line" [class]="'status-line status-' + m.validationStatus">{{
                  statusText(m)
                }}</span>
              </td>
              <td>
                <button
                  class="btn-icon"
                  type="button"
                  [attr.aria-label]="'Remover ' + m.targetPath"
                  (click)="remove($event, m)"
                >
                  <mf-icon name="trash" [size]="14" />
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <div class="empty-state small">
        <p>Nenhum mapeamento {{ store.mappings().length ? 'com esse filtro' : 'criado ainda' }}.</p>
      </div>
    }
  `,
})
export class MappingsListComponent {
  protected readonly store = inject(ProjectStore);
  private readonly state = inject(StudioState);
  private readonly confirm = inject(ConfirmService);
  protected readonly query = signal('');
  protected readonly status = signal('all');
  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const status = this.status();
    return this.store.mappings().filter((m) => {
      const text = `${m.sourcePath} ${m.targetPath}`.toLowerCase();
      if (q && !text.includes(q)) return false;
      if (status === 'all') return true;
      if (status === 'transformed') return m.transforms.length > 0;
      return m.validationStatus === status;
    });
  });

  protected steps(m: Mapping): string {
    return (
      m.transforms.map((t) => getTransform(t.transformId)?.label ?? t.transformId).join(' → ') ||
      '—'
    );
  }

  protected statusText(m: Mapping): string {
    return { valid: 'Válido', warning: 'Aviso', error: 'Erro', unknown: 'Não validado' }[
      m.validationStatus
    ];
  }

  protected open(m: Mapping): void {
    this.store.selectedMappingId.set(m.id);
    this.state.showDock('properties');
  }

  protected remove(event: Event, m: Mapping): void {
    event.stopPropagation();
    this.store.removeMapping(m.id);
  }

  protected async clear(): Promise<void> {
    const yes = await this.confirm.confirm({
      title: 'Remover todos os mapeamentos',
      message: `Os ${this.store.mappings().length} mapeamentos deste projeto serão removidos. É possível desfazer com Ctrl + Z.`,
      confirmLabel: 'Remover todos',
      danger: true,
    });
    if (yes) this.store.clearMappings();
  }
}

@Component({
  selector: 'mf-smart-panel',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preview-toolbar">
      <button
        class="btn btn-primary btn-sm"
        type="button"
        data-testid="smart-run"
        (click)="store.runSmartMapping()"
      >
        <mf-icon name="wand" [size]="14" />Analisar campos
      </button>
      <button
        class="btn btn-sm"
        type="button"
        data-testid="smart-accept-high"
        [disabled]="highCount() === 0"
        (click)="acceptHigh()"
      >
        <mf-icon name="check" [size]="14" />Aceitar alta confiança ({{ highCount() }})
      </button>
      <span class="muted small"
        >Regras determinísticas, sem IA externa. O nível vem das regras aplicadas e não é uma
        probabilidade.</span
      >
    </div>
    @if (store.suggestions().length) {
      <ul class="suggestion-list" data-testid="suggestions">
        @for (s of store.suggestions(); track s.id) {
          <li class="suggestion" [attr.data-testid]="'suggestion-' + s.targetPath">
            <div class="suggestion-main">
              <span class="confidence" [class]="'confidence confidence-' + s.level">{{
                label(s.level)
              }}</span>
              <code>{{ s.sourcePath }}</code>
              <mf-icon name="chevronRight" [size]="14" />
              <code>{{ s.targetPath }}</code>
              @if (s.ambiguous) {
                <span class="confidence confidence-ambiguous">Ambíguo</span>
              }
              <span class="spacer"></span>
              <button
                class="btn btn-sm"
                type="button"
                [attr.data-testid]="'accept-' + s.targetPath"
                (click)="store.acceptSuggestion(s.id)"
              >
                Aceitar
              </button>
              <button
                class="btn btn-sm"
                type="button"
                [attr.data-testid]="'reject-' + s.targetPath"
                (click)="store.rejectSuggestion(s.id)"
              >
                Rejeitar
              </button>
            </div>
            <ul class="reason-list">
              @for (r of s.reasons; track r) {
                <li>{{ r }}</li>
              }
            </ul>
          </li>
        }
      </ul>
    } @else {
      <div class="empty-state small">
        <mf-icon name="wand" [size]="24" />
        <p>Clique em Analisar campos para receber sugestões de correspondência.</p>
      </div>
    }
  `,
})
export class SmartPanelComponent {
  protected readonly store = inject(ProjectStore);
  private readonly toasts = inject(ToastService);
  protected readonly highCount = computed(
    () => this.store.suggestions().filter((s) => s.level === 'high' && !s.ambiguous).length,
  );

  protected label(level: ConfidenceLevel): string {
    return LEVEL_LABEL[level];
  }

  protected acceptHigh(): void {
    const n = this.store.acceptHighConfidence();
    this.toasts.success(`${n} mapeamento(s) criado(s). Ctrl + Z desfaz.`);
  }
}

@Component({
  selector: 'mf-history-panel',
  imports: [DatePipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="preview-toolbar">
      <h3 class="inline-title">Histórico local de execuções</h3>
      <span class="spacer"></span>
      <button
        class="btn btn-sm"
        type="button"
        [disabled]="records().length === 0"
        (click)="clear()"
      >
        <mf-icon name="trash" [size]="14" />Limpar
      </button>
    </div>
    @if (records().length) {
      <table class="table table-compact" data-testid="history-table">
        <thead>
          <tr>
            <th>Quando</th>
            <th>Resultado</th>
            <th>Campos</th>
            <th>Transformações</th>
            <th>Erros</th>
            <th>Avisos</th>
            <th>Tempo</th>
          </tr>
        </thead>
        <tbody>
          @for (r of records(); track r.id) {
            <tr>
              <td>{{ r.executedAt | date: 'dd/MM/yyyy HH:mm:ss' }}</td>
              <td>
                <span
                  class="status-line"
                  [class]="r.ok ? 'status-line status-valid' : 'status-line status-error'"
                  >{{ r.ok ? 'Sucesso' : 'Com erros' }}</span
                >
              </td>
              <td>{{ r.mappedFields }}</td>
              <td>{{ r.transformations }}</td>
              <td>{{ r.errors }}</td>
              <td>{{ r.warnings }}</td>
              <td>{{ r.durationMs }} ms</td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <div class="empty-state small">
        <mf-icon name="history" [size]="24" />
        <p>Use Run Mapping para registrar execuções deste projeto.</p>
      </div>
    }
  `,
})
export class HistoryPanelComponent {
  private readonly store = inject(ProjectStore);
  protected readonly records = signal<ExecutionRecord[]>([]);

  constructor() {
    effect(() => {
      this.store.libraryVersion();
      void this.load(this.store.project().id);
    });
  }

  private async load(projectId: string): Promise<void> {
    this.records.set(await this.store.repository.listExecutions(30, projectId));
  }

  protected async clear(): Promise<void> {
    await this.store.repository.clearExecutions(this.store.project().id);
    this.store.libraryVersion.update((v) => v + 1);
  }
}
