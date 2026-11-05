import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  signal,
} from '@angular/core';
import { ProjectStore } from '../../core/services/project-store.service';
import { ConfirmService, ToastService } from '../../core/services/ui.services';
import { IconComponent } from '../../shared/components/icon.component';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { DiagnosticsPanelComponent } from '../diagnostics/diagnostics-panel.component';
import {
  HistoryPanelComponent,
  MappingsListComponent,
  SmartPanelComponent,
} from './dock-panels.component';
import { MappingCanvasComponent } from './mapping-canvas/mapping-canvas.component';
import { MappingPropertiesComponent } from './mapping-properties/mapping-properties.component';
import { PreviewPanelComponent } from './preview-panel/preview-panel.component';
import { SourcePanelComponent } from './source-panel/source-panel.component';
import { DockTab, StudioState } from './studio-state.service';
import { TargetPanelComponent } from './target-panel/target-panel.component';

const SOURCE_MIN = 220;
const SIDE_MAX = 560;
const DOCK_MIN = 120;

@Component({
  selector: 'mf-mapping-studio',
  imports: [
    IconComponent,
    TooltipDirective,
    SourcePanelComponent,
    TargetPanelComponent,
    MappingCanvasComponent,
    MappingPropertiesComponent,
    PreviewPanelComponent,
    DiagnosticsPanelComponent,
    MappingsListComponent,
    SmartPanelComponent,
    HistoryPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="studio"
      [style.--source-width.px]="sourceWidth()"
      [style.--target-width.px]="targetWidth()"
      [style.--dock-height.px]="state.dockOpen() ? dockHeight() : 36"
    >
      <div class="studio-toolbar">
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Desfazer (Ctrl + Z)"
          data-testid="undo"
          [disabled]="!store.canUndo()"
          (click)="store.undo()"
        >
          <mf-icon name="undo" />
        </button>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Refazer (Ctrl + Y)"
          data-testid="redo"
          [disabled]="!store.canRedo()"
          (click)="store.redo()"
        >
          <mf-icon name="redo" />
        </button>
        <span class="header-sep"></span>
        <button class="btn btn-sm" type="button" data-testid="open-smart" (click)="openSmart()">
          <mf-icon name="wand" [size]="14" />Smart Mapping
        </button>
        <button
          class="btn btn-sm btn-primary"
          type="button"
          data-testid="toolbar-run"
          (click)="run()"
        >
          <mf-icon name="play" [size]="14" />Run Mapping
        </button>
        <div class="pane-switch" role="tablist" aria-label="Painel visível">
          <button
            role="tab"
            type="button"
            [attr.aria-selected]="state.activePane() === 'source'"
            (click)="state.activePane.set('source')"
          >
            Source
          </button>
          <button
            role="tab"
            type="button"
            [attr.aria-selected]="state.activePane() === 'canvas'"
            (click)="state.activePane.set('canvas')"
          >
            Canvas
          </button>
          <button
            role="tab"
            type="button"
            [attr.aria-selected]="state.activePane() === 'target'"
            (click)="state.activePane.set('target')"
          >
            Target
          </button>
        </div>
      </div>
      <div class="studio-panes" [attr.data-active]="state.activePane()">
        <mf-source-panel class="pane pane-source" />
        <div
          class="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar painel de origem"
          (pointerdown)="startResize($event, 'source')"
        ></div>
        <mf-mapping-canvas class="pane pane-canvas" />
        <div
          class="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar painel de destino"
          (pointerdown)="startResize($event, 'target')"
        ></div>
        <mf-target-panel class="pane pane-target" />
      </div>
      <div
        class="splitter-h"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Redimensionar painel inferior"
        (pointerdown)="startResize($event, 'dock')"
      ></div>
      <section class="dock" aria-label="Painel inferior">
        <div class="tabs dock-tabs" role="tablist">
          @for (t of tabs(); track t.id) {
            <button
              role="tab"
              type="button"
              [attr.aria-selected]="state.dockTab() === t.id && state.dockOpen()"
              [attr.data-testid]="'dock-' + t.id"
              (click)="state.showDock(t.id)"
            >
              <mf-icon [name]="t.icon" [size]="14" />{{ t.label }}
              @if (t.badge) {
                <span
                  class="tab-badge"
                  [class.tab-badge-error]="t.danger"
                  [attr.data-testid]="'dock-badge-' + t.id"
                  >{{ t.badge }}</span
                >
              }
            </button>
          }
          <span class="spacer"></span>
          <button
            class="btn-icon"
            type="button"
            [attr.aria-expanded]="state.dockOpen()"
            [mfTooltip]="state.dockOpen() ? 'Recolher painel' : 'Expandir painel'"
            (click)="state.dockOpen.set(!state.dockOpen())"
          >
            <mf-icon name="chevronDown" [size]="15" [class.flip]="!state.dockOpen()" />
          </button>
        </div>
        @if (state.dockOpen()) {
          <div class="dock-body" role="tabpanel">
            @switch (state.dockTab()) {
              @case ('preview') {
                <mf-preview-panel />
              }
              @case ('properties') {
                <mf-mapping-properties />
              }
              @case ('mappings') {
                <mf-mappings-list />
              }
              @case ('smart') {
                <mf-smart-panel />
              }
              @case ('diagnostics') {
                <mf-diagnostics-panel />
              }
              @case ('history') {
                <mf-history-panel />
              }
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class MappingStudioComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly state = inject(StudioState);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly sourceWidth = signal(310);
  protected readonly targetWidth = signal(310);
  protected readonly dockHeight = signal(290);

  protected readonly tabs = computed<
    { id: DockTab; label: string; icon: string; badge?: number; danger?: boolean }[]
  >(() => {
    const d = this.store.diagnostics();
    const errors = d.filter((x) => x.severity === 'error').length;
    return [
      { id: 'preview', label: 'Preview', icon: 'play' },
      { id: 'properties', label: 'Properties', icon: 'edit' },
      { id: 'mappings', label: 'Mappings', icon: 'list', badge: this.store.mappings().length },
      { id: 'smart', label: 'Smart Mapping', icon: 'wand', badge: this.store.suggestions().length },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        icon: 'warning',
        badge: d.length,
        danger: errors > 0,
      },
      { id: 'history', label: 'History', icon: 'history' },
    ];
  });

  private resizing: { kind: 'source' | 'target' | 'dock'; start: number; initial: number } | null =
    null;

  protected openSmart(): void {
    this.store.runSmartMapping();
    this.state.showDock('smart');
  }

  protected async run(): Promise<void> {
    this.state.showDock('preview');
    const r = await this.store.runMapping();
    if (r) {
      const errors = r.issues.filter((i) => i.severity === 'error').length;
      if (errors) this.toasts.warning(`Execução concluída com ${errors} erro(s).`);
      else this.toasts.success(`Execução concluída: ${r.stats.mappedFields} campos mapeados.`);
    }
  }

  protected startResize(event: PointerEvent, kind: 'source' | 'target' | 'dock'): void {
    event.preventDefault();
    const initial =
      kind === 'source'
        ? this.sourceWidth()
        : kind === 'target'
          ? this.targetWidth()
          : this.dockHeight();
    this.resizing = { kind, start: kind === 'dock' ? event.clientY : event.clientX, initial };
  }

  @HostListener('document:pointermove', ['$event'])
  protected onMove(event: PointerEvent): void {
    const r = this.resizing;
    if (!r) return;
    if (r.kind === 'dock') {
      this.dockHeight.set(
        Math.max(DOCK_MIN, Math.min(window.innerHeight - 200, r.initial + r.start - event.clientY)),
      );
    } else if (r.kind === 'source') {
      this.sourceWidth.set(
        Math.max(SOURCE_MIN, Math.min(SIDE_MAX, r.initial + event.clientX - r.start)),
      );
    } else {
      this.targetWidth.set(
        Math.max(SOURCE_MIN, Math.min(SIDE_MAX, r.initial + r.start - event.clientX)),
      );
    }
  }

  @HostListener('document:pointerup')
  protected onUp(): void {
    this.resizing = null;
  }
}
