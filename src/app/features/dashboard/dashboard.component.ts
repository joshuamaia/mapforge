import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MapForgeProject } from '../../core/models/project.model';
import { ProjectStore } from '../../core/services/project-store.service';
import { IconComponent } from '../../shared/components/icon.component';
import { computeMetrics, DashboardMetrics } from './dashboard-metrics';

@Component({
  selector: 'mf-dashboard',
  imports: [DatePipe, IconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Dashboard</h1>
          <p class="muted">Indicadores dos projetos salvos neste navegador.</p>
        </div>
        <div class="row">
          <a class="btn" routerLink="/examples"
            ><mf-icon name="examples" [size]="14" />Ver exemplos</a
          >
          <a class="btn btn-primary" routerLink="/studio"
            ><mf-icon name="studio" [size]="14" />Abrir o Studio</a
          >
        </div>
      </header>

      @if (metrics(); as m) {
        <div class="stat-grid">
          <div class="stat-tile">
            <span class="stat-value" data-testid="metric-projects">{{ m.totalProjects }}</span
            ><span class="stat-label">Projetos</span>
          </div>
          <div class="stat-tile">
            <span class="stat-value" data-testid="metric-mappings">{{ m.totalMappings }}</span
            ><span class="stat-label">Mapeamentos criados</span>
          </div>
          <div class="stat-tile">
            <span class="stat-value" data-testid="metric-transforms">{{
              m.totalTransformations
            }}</span
            ><span class="stat-label">Transformações utilizadas</span>
          </div>
          <div class="stat-tile">
            <span class="stat-value" data-testid="metric-errors">{{ m.withErrors.length }}</span
            ><span class="stat-label">Projetos com erros</span>
          </div>
        </div>

        @if (m.totalProjects === 0) {
          <div class="card empty-state">
            <mf-icon name="folder" [size]="30" />
            <p>
              Nenhum projeto salvo ainda. Abra um exemplo ou crie um mapeamento e salve para ver os
              indicadores.
            </p>
            <a class="btn btn-sm btn-primary" routerLink="/examples">Abrir um exemplo</a>
          </div>
        } @else {
          <div class="dash-grid">
            <section class="card">
              <h2>Últimos projetos</h2>
              <ul class="simple-list" data-testid="recent-projects">
                @for (p of m.recentProjects; track p.id) {
                  <li>
                    <button type="button" class="link-row" (click)="open(p)">
                      <span class="ellipsis">{{ p.name }}</span
                      ><span class="muted small">{{ p.updatedAt | date: 'dd/MM HH:mm' }}</span>
                    </button>
                  </li>
                }
              </ul>
            </section>

            <section class="card">
              <h2>Projetos favoritos</h2>
              <ul class="simple-list" data-testid="favorite-projects">
                @for (p of m.favorites; track p.id) {
                  <li>
                    <button type="button" class="link-row" (click)="open(p)">
                      <mf-icon name="star" [size]="14" /><span class="ellipsis">{{ p.name }}</span>
                    </button>
                  </li>
                } @empty {
                  <li class="muted small">Nenhum favorito. Marque na tela Saved Projects.</li>
                }
              </ul>
            </section>

            <section class="card">
              <h2>Mapeamentos com erros</h2>
              <ul class="simple-list" data-testid="error-projects">
                @for (e of m.withErrors; track e.project.id) {
                  <li>
                    <button type="button" class="link-row" (click)="open(e.project)">
                      <mf-icon name="error" [size]="14" /><span class="ellipsis">{{
                        e.project.name
                      }}</span
                      ><span class="muted small">{{ e.errors }} erro(s)</span>
                    </button>
                  </li>
                } @empty {
                  <li class="muted small">
                    <mf-icon name="check" [size]="14" /> Nenhum projeto com erros.
                  </li>
                }
              </ul>
            </section>

            <section class="card">
              <h2>Últimas execuções</h2>
              <ul class="simple-list" data-testid="recent-executions">
                @for (r of m.recentExecutions; track r.id) {
                  <li class="exec-row">
                    <mf-icon [name]="r.ok ? 'check' : 'error'" [size]="14" />
                    <span class="ellipsis">{{ r.projectName }}</span>
                    <span class="muted small"
                      >{{ r.ok ? 'Sucesso' : r.errors + ' erro(s)' }} · {{ r.mappedFields }} campos
                      · {{ r.executedAt | date: 'dd/MM HH:mm' }}</span
                    >
                  </li>
                } @empty {
                  <li class="muted small">
                    Nenhuma execução registrada. Use Run Mapping no Studio.
                  </li>
                }
              </ul>
            </section>

            <section class="card dash-wide">
              <h2>Transformações mais usadas</h2>
              @if (m.topTransformations.length) {
                <ul class="bar-list" data-testid="top-transformations">
                  @for (t of m.topTransformations; track t.id) {
                    <li class="bar-row" [title]="t.label + ': usada ' + t.count + ' vez(es)'">
                      <span class="bar-label">{{ t.label }}</span>
                      <span class="bar-track"
                        ><span
                          class="bar-fill"
                          [style.width.%]="(t.count / maxCount()) * 100"
                        ></span
                      ></span>
                      <span class="bar-value">{{ t.count }}</span>
                    </li>
                  }
                </ul>
              } @else {
                <p class="muted small">Nenhuma transformação usada ainda.</p>
              }
            </section>
          </div>
        }
      } @else {
        <div class="empty-state" role="status">
          <span class="spinner"></span> Calculando indicadores…
        </div>
      }
    </div>
  `,
})
export class DashboardComponent {
  private readonly store = inject(ProjectStore);
  private readonly router = inject(Router);
  protected readonly metrics = signal<DashboardMetrics | null>(null);
  protected readonly maxCount = computed(() =>
    Math.max(1, ...(this.metrics()?.topTransformations ?? []).map((t) => t.count)),
  );

  constructor() {
    effect(() => {
      this.store.libraryVersion();
      void this.load();
    });
  }

  private async load(): Promise<void> {
    const [projects, executions] = await Promise.all([
      this.store.repository.list(),
      this.store.repository.listExecutions(20),
    ]);
    this.metrics.set(computeMetrics(projects, executions));
  }

  protected async open(p: MapForgeProject): Promise<void> {
    if (await this.store.openProject(p.id)) await this.router.navigateByUrl('/studio');
  }
}
