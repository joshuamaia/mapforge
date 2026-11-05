import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ProjectStore } from './core/services/project-store.service';
import { SettingsService } from './core/services/settings.service';
import { ToastService } from './core/services/ui.services';
import { IconComponent } from './shared/components/icon.component';
import {
  ConfirmDialogComponent,
  ShortcutsDialogComponent,
  ToastsComponent,
} from './shared/components/overlays.component';
import { TooltipDirective } from './shared/directives/tooltip.directive';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/studio', label: 'Mapping Studio', icon: 'studio' },
  { path: '/transformations', label: 'Transformations', icon: 'transform' },
  { path: '/code', label: 'Code Generator', icon: 'code' },
  { path: '/examples', label: 'Examples', icon: 'examples' },
  { path: '/projects', label: 'Saved Projects', icon: 'folder' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];

/** Campos de texto cuidam dos próprios atalhos, como o undo do editor. */
function isEditing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .monaco-editor');
}

@Component({
  selector: 'mf-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    IconComponent,
    TooltipDirective,
    ToastsComponent,
    ConfirmDialogComponent,
    ShortcutsDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main">Pular para o conteúdo</a>
    <header class="app-header">
      <button
        class="btn-icon nav-toggle"
        type="button"
        aria-label="Alternar menu"
        (click)="navOpen.set(!navOpen())"
      >
        <mf-icon name="menu" />
      </button>
      <a routerLink="/dashboard" class="logo" aria-label="MapForge, ir para o Dashboard">
        <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--logo-bg)" />
          <circle cx="8" cy="9" r="3" fill="#2dd4bf" />
          <circle cx="8" cy="23" r="3" fill="#2dd4bf" />
          <circle cx="24" cy="16" r="3.4" fill="#fbbf24" />
          <path
            d="M11 9c7 0 5 7 10 7M11 23c7 0 5-7 10-7"
            fill="none"
            stroke="#a5b4fc"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <span>MapForge</span>
      </a>
      <div class="project-name">
        <input
          aria-label="Nome do projeto atual"
          data-testid="project-name"
          [value]="store.project().name"
          (change)="store.rename($any($event.target).value)"
        />
        @if (store.dirty()) {
          <span
            class="dirty-dot"
            data-testid="dirty"
            role="status"
            mfTooltip="Há alterações não salvas"
            ariaLabel="Alterações não salvas"
          ></span>
        }
      </div>
      <div class="header-actions">
        <button class="btn btn-sm" type="button" data-testid="new-mapping" (click)="newMapping()">
          <mf-icon name="plus" [size]="14" /><span>New Mapping</span>
        </button>
        <button class="btn btn-sm" type="button" (click)="router.navigateByUrl('/projects')">
          <mf-icon name="folder" [size]="14" /><span>Open</span>
        </button>
        <button
          class="btn btn-sm"
          type="button"
          data-testid="save"
          [disabled]="store.saving()"
          (click)="store.save()"
        >
          <mf-icon name="save" [size]="14" /><span>Save</span>
        </button>
        <button class="btn btn-sm" type="button" (click)="file.click()">
          <mf-icon name="upload" [size]="14" /><span>Import</span>
        </button>
        <button
          class="btn btn-sm"
          type="button"
          data-testid="export"
          (click)="store.exportCurrent()"
        >
          <mf-icon name="download" [size]="14" /><span>Export</span>
        </button>
        <input
          #file
          class="sr-only"
          type="file"
          accept=".json,application/json"
          aria-label="Importar projeto"
          tabindex="-1"
          data-testid="import-project"
          (change)="importFile($event)"
        />
        <span class="header-sep"></span>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Atalhos de teclado (?)"
          (click)="showShortcuts.set(true)"
        >
          <mf-icon name="keyboard" />
        </button>
        <button
          class="btn-icon"
          type="button"
          data-testid="theme-toggle"
          [mfTooltip]="settings.theme() === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'"
          (click)="settings.toggleTheme()"
        >
          <mf-icon [name]="settings.theme() === 'dark' ? 'sun' : 'moon'" />
        </button>
      </div>
    </header>
    <div class="app-body">
      <nav class="app-nav" [class.open]="navOpen()" aria-label="Navegação principal">
        @for (item of nav; track item.path) {
          <a
            [routerLink]="item.path"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
            (click)="navOpen.set(false)"
            ><mf-icon [name]="item.icon" [size]="17" /><span>{{ item.label }}</span></a
          >
        }
      </nav>
      <main id="main" class="app-main" tabindex="-1"><router-outlet /></main>
    </div>
    <mf-toasts />
    <mf-confirm-dialog />
    <mf-shortcuts-dialog [open]="showShortcuts()" (closed)="showShortcuts.set(false)" />
  `,
})
export class App {
  protected readonly store = inject(ProjectStore);
  protected readonly settings = inject(SettingsService);
  protected readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly nav = NAV;
  protected readonly navOpen = signal(false);
  protected readonly showShortcuts = signal(false);

  protected async newMapping(): Promise<void> {
    if (await this.store.newProject()) await this.router.navigateByUrl('/studio');
  }

  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const project = await this.store.importProjectFile(file);
    if (project && (await this.store.openProject(project.id)))
      await this.router.navigateByUrl('/studio');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected warnUnsaved(event: BeforeUnloadEvent): void {
    if (this.store.dirty()) event.preventDefault();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && key === 's') {
      e.preventDefault();
      void this.store.save();
    } else if (mod && key === 'enter') {
      e.preventDefault();
      void this.store
        .runMapping()
        .then(
          (r) =>
            r && this.toasts.info(`Execução concluída: ${r.stats.mappedFields} campos mapeados.`),
        );
    } else if (isEditing(e.target)) {
      return;
    } else if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      this.store.redo();
    } else if (key === 'delete' && this.store.selectedMappingId()) {
      this.store.removeMapping(this.store.selectedMappingId() as string);
    } else if (e.key === '?') {
      this.showShortcuts.set(true);
    } else if (key === 'escape') {
      this.showShortcuts.set(false);
    }
  }
}
