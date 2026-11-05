import { Injectable, signal } from '@angular/core';
import { Side } from '../../core/services/project-store.service';

export type DockTab = 'preview' | 'properties' | 'mappings' | 'smart' | 'diagnostics' | 'history';

/** Estado só de interface do Mapping Studio. Sobrevive à troca de rotas e não entra no undo. */
@Injectable({ providedIn: 'root' })
export class StudioState {
  readonly collapsed = {
    source: signal<ReadonlySet<string>>(new Set()),
    target: signal<ReadonlySet<string>>(new Set()),
  };
  readonly query = { source: signal(''), target: signal('') };
  readonly dockTab = signal<DockTab>('preview');
  readonly dockOpen = signal(true);
  /** Painel visível em telas estreitas. */
  readonly activePane = signal<'source' | 'canvas' | 'target'>('canvas');
  /** Ponto escolhido pelo clique ou teclado, à espera do outro lado da conexão. */
  readonly armed = signal<{ side: Side; path: string } | null>(null);

  toggleCollapsed(side: Side, path: string): void {
    this.collapsed[side].update((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  showDock(tab: DockTab): void {
    this.dockTab.set(tab);
    this.dockOpen.set(true);
  }
}
