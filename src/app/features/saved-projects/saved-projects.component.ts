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
import { projectFileName, serializeProject } from '../../core/storage/project-file';
import { downloadText, ProjectStore } from '../../core/services/project-store.service';
import { ConfirmService, ToastService } from '../../core/services/ui.services';
import { IconComponent } from '../../shared/components/icon.component';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

@Component({
  selector: 'mf-saved-projects',
  imports: [DatePipe, IconComponent, RouterLink, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Saved Projects</h1>
          <p class="muted">
            Projetos guardados neste navegador, em IndexedDB. Nada é enviado para fora.
          </p>
        </div>
        <div class="row">
          <button class="btn" type="button" (click)="file.click()">
            <mf-icon name="upload" [size]="14" />Importar
          </button>
          <input
            #file
            class="sr-only"
            type="file"
            accept=".json,application/json"
            tabindex="-1"
            aria-label="Importar projeto"
            data-testid="projects-import"
            (change)="importFile($event)"
          />
          <button class="btn btn-primary" type="button" (click)="create()">
            <mf-icon name="plus" [size]="14" />Novo projeto
          </button>
        </div>
      </header>
      <div class="toolbar">
        <div class="panel-search inline">
          <mf-icon name="search" [size]="14" />
          <input
            type="search"
            placeholder="Buscar por nome ou descrição"
            aria-label="Buscar projetos"
            data-testid="project-search"
            [value]="query()"
            (input)="onSearch($any($event.target).value)"
          />
        </div>
        <label class="inline-check"
          ><input
            type="checkbox"
            data-testid="only-favorites"
            [checked]="onlyFavorites()"
            (change)="onlyFavorites.set($any($event.target).checked)"
          />Somente favoritos</label
        >
      </div>
      @if (loading()) {
        <div class="empty-state" role="status">
          <span class="spinner"></span> Carregando projetos…
        </div>
      } @else if (visible().length) {
        <ul class="project-list" data-testid="project-list">
          @for (p of visible(); track p.id) {
            <li class="project-row" [attr.data-testid]="'project-' + p.name">
              <button
                class="btn-icon star"
                type="button"
                [class.on]="p.favorite"
                [mfTooltip]="p.favorite ? 'Remover dos favoritos' : 'Favoritar'"
                [attr.aria-pressed]="p.favorite"
                data-testid="favorite"
                (click)="toggleFavorite(p)"
              >
                <mf-icon name="star" />
              </button>
              <div class="project-main">
                @if (renaming() === p.id) {
                  <input
                    class="rename-input"
                    aria-label="Novo nome do projeto"
                    data-testid="rename-input"
                    [value]="p.name"
                    (keydown.enter)="finishRename(p, $any($event.target).value)"
                    (keydown.escape)="renaming.set(null)"
                    (blur)="finishRename(p, $any($event.target).value)"
                  />
                } @else {
                  <button
                    type="button"
                    class="project-name-link"
                    data-testid="open-project"
                    (click)="open(p)"
                  >
                    {{ p.name }}
                  </button>
                }
                <span class="muted small"
                  >{{ p.document.mappings.length }} mapeamentos · atualizado em
                  {{ p.updatedAt | date: 'dd/MM/yyyy HH:mm' }}
                  @if (p.description) {
                    · {{ p.description }}
                  }
                </span>
              </div>
              <div class="project-actions">
                <button
                  class="btn-icon"
                  type="button"
                  mfTooltip="Renomear"
                  data-testid="rename"
                  (click)="renaming.set(p.id)"
                >
                  <mf-icon name="edit" />
                </button>
                <button
                  class="btn-icon"
                  type="button"
                  mfTooltip="Duplicar"
                  data-testid="duplicate"
                  (click)="duplicate(p)"
                >
                  <mf-icon name="copy" />
                </button>
                <button
                  class="btn-icon"
                  type="button"
                  mfTooltip="Exportar"
                  data-testid="export-project"
                  (click)="exportProject(p)"
                >
                  <mf-icon name="download" />
                </button>
                <button
                  class="btn-icon danger"
                  type="button"
                  mfTooltip="Excluir"
                  data-testid="delete"
                  (click)="remove(p)"
                >
                  <mf-icon name="trash" />
                </button>
              </div>
            </li>
          }
        </ul>
      } @else {
        <div class="empty-state">
          <mf-icon name="folder" [size]="30" />
          <p>
            {{
              projects().length
                ? 'Nenhum projeto encontrado.'
                : 'Você ainda não salvou nenhum projeto.'
            }}
          </p>
          @if (!projects().length) {
            <a class="btn btn-sm" routerLink="/examples">Ver exemplos</a>
          }
        </div>
      }
    </div>
  `,
})
export class SavedProjectsComponent {
  private readonly store = inject(ProjectStore);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  protected readonly projects = signal<MapForgeProject[]>([]);
  protected readonly results = signal<MapForgeProject[]>([]);
  protected readonly query = signal('');
  protected readonly onlyFavorites = signal(false);
  protected readonly loading = signal(true);
  protected readonly renaming = signal<string | null>(null);
  protected readonly visible = computed(() =>
    this.results().filter((p) => !this.onlyFavorites() || p.favorite),
  );

  constructor() {
    effect(() => {
      this.store.libraryVersion();
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.projects.set(await this.store.repository.list());
    this.results.set(await this.store.repository.search(this.query()));
    this.loading.set(false);
  }

  protected onSearch(term: string): void {
    this.query.set(term);
    void this.load();
  }

  protected async create(): Promise<void> {
    if (await this.store.newProject()) await this.router.navigateByUrl('/studio');
  }

  protected async open(p: MapForgeProject): Promise<void> {
    if (await this.store.openProject(p.id)) await this.router.navigateByUrl('/studio');
  }

  protected async toggleFavorite(p: MapForgeProject): Promise<void> {
    await this.store.repository.setFavorite(p.id, !p.favorite);
    this.store.syncFromLibrary({ ...p, favorite: !p.favorite });
  }

  protected async finishRename(p: MapForgeProject, name: string): Promise<void> {
    if (this.renaming() !== p.id) return;
    this.renaming.set(null);
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === p.name) return;
    await this.store.repository.rename(p.id, trimmed);
    this.store.syncFromLibrary({ ...p, name: trimmed });
  }

  protected async duplicate(p: MapForgeProject): Promise<void> {
    const copy = await this.store.repository.duplicate(p.id);
    this.store.libraryVersion.update((v) => v + 1);
    this.toasts.success(`Criado "${copy.name}".`);
  }

  protected exportProject(p: MapForgeProject): void {
    downloadText(projectFileName(p.name), serializeProject(p));
  }

  protected async remove(p: MapForgeProject): Promise<void> {
    const yes = await this.confirm.confirm({
      title: 'Excluir projeto',
      message: `"${p.name}" e o histórico de execuções dele serão excluídos. Essa ação não pode ser desfeita.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    await this.store.repository.delete(p.id);
    this.store.handleDeleted(p.id);
    this.toasts.success(`"${p.name}" excluído.`);
  }

  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.store.importProjectFile(file);
  }
}
