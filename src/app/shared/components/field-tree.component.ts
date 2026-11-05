import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FieldNode } from '../../core/models/schema.model';
import { ProjectStore, Side } from '../../core/services/project-store.service';
import { StudioState } from '../../features/mapping-studio/studio-state.service';
import { IconComponent } from './icon.component';

interface TreeRow {
  node: FieldNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  mapped: boolean;
}

export interface PortEvent {
  side: Side;
  path: string;
  event: Event;
}

/**
 * Árvore de campos. A lista é plana e deriva do estado de expansão, compartilhado entre o painel
 * lateral e o canvas. Com `ports`, cada linha expõe o ponto de conexão usado pelas linhas SVG.
 */
@Component({
  selector: 'mf-field-tree',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length === 0) {
      <p class="tree-empty">
        {{ query() ? 'Nenhum campo encontrado.' : 'Nenhum campo: informe uma estrutura válida.' }}
      </p>
    }
    <ul
      class="tree"
      role="tree"
      [attr.aria-label]="side() === 'source' ? 'Campos de origem' : 'Campos de destino'"
    >
      @for (row of rows(); track row.node.path) {
        <li
          class="tree-row"
          role="treeitem"
          [attr.aria-expanded]="row.expandable ? row.expanded : null"
          [attr.data-testid]="testPrefix() + '-row-' + row.node.path"
          [class.mapped]="row.mapped"
          [class.highlight]="isHighlighted(row.node.path)"
          [class.side-target]="side() === 'target'"
          [style.--depth]="row.depth"
          (click)="rowClick.emit(row.node)"
        >
          @if (ports() && side() === 'target') {
            <button
              class="port"
              type="button"
              [class.armed]="isArmed(row.node.path)"
              [attr.data-port-side]="side()"
              [attr.data-port-path]="row.node.path"
              [attr.aria-label]="'Conectar destino ' + row.node.path"
              (pointerdown)="portDown.emit({ side: side(), path: row.node.path, event: $event })"
              (click)="onPortClick($event, row.node.path)"
            ></button>
          }
          @if (row.expandable) {
            <button
              class="tree-chevron"
              type="button"
              [attr.aria-label]="(row.expanded ? 'Recolher ' : 'Expandir ') + row.node.name"
              (click)="toggle($event, row.node.path)"
            >
              <mf-icon [name]="row.expanded ? 'chevronDown' : 'chevronRight'" [size]="13" />
            </button>
          } @else {
            <span class="tree-chevron-spacer"></span>
          }
          <span class="tree-name" [title]="row.node.path">{{ row.node.name }}</span>
          @if (row.node.required) {
            <span class="req" title="Obrigatório" aria-label="obrigatório">*</span>
          }
          <span
            class="type-badge"
            [class]="'type-badge type-' + row.node.type"
            [title]="row.node.nativeType ?? row.node.type"
            >{{ typeLabel(row.node) }}</span
          >
          @if (showStatus()) {
            <span
              class="map-state"
              [class.on]="row.mapped"
              [attr.aria-label]="row.mapped ? 'mapeado' : 'não mapeado'"
              [title]="row.mapped ? 'Mapeado' : 'Não mapeado'"
            ></span>
          }
          @if (ports() && side() === 'source') {
            <button
              class="port"
              type="button"
              [class.armed]="isArmed(row.node.path)"
              [attr.data-port-side]="side()"
              [attr.data-port-path]="row.node.path"
              [attr.aria-label]="'Conectar origem ' + row.node.path"
              (pointerdown)="portDown.emit({ side: side(), path: row.node.path, event: $event })"
              (click)="onPortClick($event, row.node.path)"
            ></button>
          }
        </li>
      }
    </ul>
  `,
})
export class FieldTreeComponent {
  readonly side = input.required<Side>();
  readonly root = input.required<FieldNode | null>();
  readonly ports = input(false);
  readonly showStatus = input(false);
  readonly testPrefix = input('tree');
  readonly portDown = output<PortEvent>();
  readonly portClick = output<PortEvent>();
  readonly rowClick = output<FieldNode>();

  private readonly state = inject(StudioState);
  private readonly store = inject(ProjectStore);

  protected readonly query = computed(() => this.state.query[this.side()]().trim().toLowerCase());

  protected readonly rows = computed<TreeRow[]>(() => {
    const root = this.root();
    if (!root) return [];
    const collapsed = this.state.collapsed[this.side()]();
    const query = this.query();
    const mapped =
      this.side() === 'source' ? this.store.mappedSources() : this.store.mappedTargets();
    const out: TreeRow[] = [];
    const matches = (n: FieldNode): boolean =>
      n.name.toLowerCase().includes(query) ||
      n.path.toLowerCase().includes(query) ||
      (n.children ?? []).some(matches);
    const visit = (n: FieldNode, depth: number): void => {
      if (query && !matches(n)) return;
      const children = n.children ?? [];
      const expandable = children.length > 0;
      const expanded = expandable && (query !== '' || !collapsed.has(n.path));
      out.push({
        node: n,
        depth,
        expandable,
        expanded,
        mapped:
          mapped.has(n.path) ||
          [...mapped].some((p) => p.startsWith(`${n.path}.`) || p.startsWith(`${n.path}[`)),
      });
      if (expanded) children.forEach((c) => visit(c, depth + 1));
    };
    (root.children ?? []).forEach((c) => visit(c, 0));
    return out;
  });

  protected typeLabel(n: FieldNode): string {
    if (n.type === 'array') return `${n.itemType ?? 'any'}[]`;
    return n.type;
  }

  protected isArmed(path: string): boolean {
    const a = this.state.armed();
    return !!a && a.side === this.side() && a.path === path;
  }

  protected isHighlighted(path: string): boolean {
    const h = this.store.highlightedPath();
    if (h && h.side === this.side() && h.path === path) return true;
    const m = this.store.selectedMapping();
    return !!m && (this.side() === 'source' ? m.sourcePath : m.targetPath) === path;
  }

  protected toggle(event: Event, path: string): void {
    event.stopPropagation();
    this.state.toggleCollapsed(this.side(), path);
  }

  protected onPortClick(event: Event, path: string): void {
    event.stopPropagation();
    this.portClick.emit({ side: this.side(), path, event });
  }
}
