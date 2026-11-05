import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { Mapping } from '../../../core/models/mapping.model';
import { ProjectStore, Side } from '../../../core/services/project-store.service';
import { getTransform } from '../../../core/transformations/catalog';
import { FieldTreeComponent, PortEvent } from '../../../shared/components/field-tree.component';
import { IconComponent } from '../../../shared/components/icon.component';
import { TooltipDirective } from '../../../shared/directives/tooltip.directive';
import { StudioState } from '../studio-state.service';
import {
  ancestorChain,
  clamp,
  connectionMiddle,
  connectionPath,
  Point,
  zoomAround,
} from './connection-geometry';

interface Line {
  id: string;
  d: string;
  mid: Point;
  status: Mapping['validationStatus'];
  selected: boolean;
  /** Algum dos campos está recolhido ou fora da área visível do cartão. */
  approximate: boolean;
  label: string;
  labelWidth: number;
  title: string;
}

interface Drag {
  side: Side;
  path: string;
  from: Point;
  to: Point;
  moved: boolean;
}

const CARD_WIDTH = 280;
const CARD_GAP = 210;
const MARGIN = 20;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.8;

@Component({
  selector: 'mf-mapping-canvas',
  imports: [FieldTreeComponent, IconComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
  `,
  template: `
    <section class="panel canvas-panel" aria-labelledby="canvas-title">
      <header class="panel-header">
        <h2 id="canvas-title">Mapping Canvas</h2>
        <span class="count-chip" data-testid="connection-count"
          >{{ store.mappings().length }} conexões</span
        >
        @if (state.armed(); as armed) {
          <span class="armed-chip" role="status"
            >Escolha o campo de {{ armed.side === 'source' ? 'destino' : 'origem' }} · Esc
            cancela</span
          >
        }
        <span class="spacer"></span>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Zoom out"
          data-testid="zoom-out"
          (click)="zoomBy(1 / 1.2)"
        >
          <mf-icon name="zoomOut" />
        </button>
        <span class="zoom-label" data-testid="zoom-level">{{ zoomPercent() }}%</span>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Zoom in"
          data-testid="zoom-in"
          (click)="zoomBy(1.2)"
        >
          <mf-icon name="zoomIn" />
        </button>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Fit to Screen"
          data-testid="fit"
          (click)="fit()"
        >
          <mf-icon name="fit" />
        </button>
        <button
          class="btn-icon"
          type="button"
          mfTooltip="Reset View"
          data-testid="reset-view"
          (click)="resetView()"
        >
          <mf-icon name="reset" />
        </button>
      </header>
      <div
        #viewport
        class="canvas-viewport"
        data-testid="canvas"
        [class.panning]="panning()"
        (pointerdown)="onBackgroundDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="cancelPointer()"
        (wheel)="onWheel($event)"
      >
        <div #world class="canvas-world" [style.transform]="worldTransform()">
          <div
            class="canvas-card"
            [style.left.px]="margin"
            [style.width.px]="cardWidth"
            [style.height.px]="cardHeight()"
            data-testid="source-card"
          >
            <div class="canvas-card-title">
              <span class="dot dot-source"></span>{{ store.sourceParsed().rootName }}
            </div>
            <div class="canvas-card-scroll" data-card-scroll="source">
              <mf-field-tree
                side="source"
                testPrefix="canvas-source"
                [root]="store.sourceParsed().root"
                [ports]="true"
                (portDown)="onPortDown($event)"
                (portClick)="onPortClick($event)"
              />
            </div>
          </div>
          <div
            class="canvas-card"
            [style.left.px]="margin + cardWidth + gap"
            [style.width.px]="cardWidth"
            [style.height.px]="cardHeight()"
            data-testid="target-card"
          >
            <div class="canvas-card-title">
              <span class="dot dot-target"></span>{{ store.targetParsed().rootName }}
            </div>
            <div class="canvas-card-scroll" data-card-scroll="target">
              <mf-field-tree
                side="target"
                testPrefix="canvas-target"
                [root]="store.targetParsed().root"
                [ports]="true"
                (portDown)="onPortDown($event)"
                (portClick)="onPortClick($event)"
              />
            </div>
          </div>
        </div>
        <svg class="canvas-lines" aria-label="Conexões entre campos">
          @for (line of lines(); track line.id) {
            <g
              class="connection"
              role="button"
              tabindex="0"
              [attr.data-testid]="'connection-' + line.id"
              [attr.data-path]="line.d"
              [class.selected]="line.selected"
              [class.approximate]="line.approximate"
              [class.is-error]="line.status === 'error'"
              [class.is-warning]="line.status === 'warning'"
              [attr.aria-label]="line.title"
              [attr.aria-pressed]="line.selected"
              (click)="select($event, line.id)"
              (keydown.enter)="select($event, line.id)"
              (keydown.delete)="remove($event, line.id)"
            >
              <title>{{ line.title }}</title>
              <path class="connection-hit" [attr.d]="line.d" />
              <path class="connection-line" [attr.d]="line.d" />
              @if (line.label) {
                <g
                  class="connection-label"
                  [attr.transform]="'translate(' + line.mid.x + ',' + line.mid.y + ')'"
                >
                  <rect
                    [attr.x]="-line.labelWidth / 2"
                    y="-10"
                    [attr.width]="line.labelWidth"
                    height="20"
                    rx="4"
                  />
                  <text text-anchor="middle" y="4">{{ line.label }}</text>
                </g>
              }
              @if (line.status === 'error' || line.status === 'warning') {
                <g
                  class="connection-flag"
                  [attr.transform]="
                    'translate(' + line.mid.x + ',' + (line.mid.y - (line.label ? 20 : 0)) + ')'
                  "
                >
                  <circle r="8" />
                  <text text-anchor="middle" y="4">!</text>
                </g>
              }
            </g>
          }
          @if (drag(); as d) {
            <path class="connection-temp" [attr.d]="tempPath(d)" />
          }
        </svg>
        @if (isEmpty()) {
          <div class="canvas-hint" role="note">
            <strong>Comece pelas estruturas</strong>
            <span
              >Informe um JSON, um DTO Java ou uma interface TypeScript nos painéis laterais.
              Depois, arraste de um ponto da origem até um ponto do destino.</span
            >
          </div>
        } @else if (store.mappings().length === 0) {
          <div class="canvas-hint canvas-hint-bottom" role="note">
            <span
              >Arraste entre os pontos para conectar, ou clique em um ponto e depois no outro. O
              Smart Mapping sugere correspondências.</span
            >
          </div>
        }
      </div>
    </section>
  `,
})
export class MappingCanvasComponent implements AfterViewInit, OnDestroy {
  protected readonly store = inject(ProjectStore);
  protected readonly state = inject(StudioState);
  protected readonly margin = MARGIN;
  protected readonly cardWidth = CARD_WIDTH;
  protected readonly gap = CARD_GAP;

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly world = viewChild.required<ElementRef<HTMLElement>>('world');

  protected readonly view = signal({ x: 0, y: 0, scale: 1 });
  protected readonly cardHeight = signal(420);
  protected readonly lines = signal<Line[]>([]);
  protected readonly drag = signal<Drag | null>(null);
  protected readonly panning = signal(false);
  protected readonly worldTransform = computed(() => {
    const v = this.view();
    return `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  });
  protected readonly zoomPercent = computed(() => Math.round(this.view().scale * 100));
  protected readonly isEmpty = computed(
    () =>
      !this.store.sourceParsed().root?.children?.length &&
      !this.store.targetParsed().root?.children?.length,
  );

  private panStart: { x: number; y: number; vx: number; vy: number } | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly onScroll = (): void => this.schedule();

  constructor() {
    // Mudanças de dados e de vista redesenham as linhas; expansão e scroll são vistos nos observers.
    effect(() => {
      this.store.mappings();
      this.store.selectedMappingId();
      this.view();
      this.cardHeight();
      this.schedule();
    });
  }

  ngAfterViewInit(): void {
    const viewport = this.viewport().nativeElement;
    // Eventos de scroll não sobem pela árvore, mas são vistos na fase de captura.
    viewport.addEventListener('scroll', this.onScroll, true);
    if (typeof ResizeObserver !== 'undefined') {
      let first = true;
      this.resizeObserver = new ResizeObserver(() => {
        if (first) {
          first = false;
          this.fit();
        }
        this.schedule();
      });
      this.resizeObserver.observe(viewport);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver(() => this.schedule());
      this.mutationObserver.observe(this.world().nativeElement, { childList: true, subtree: true });
    }
    this.schedule();
  }

  ngOnDestroy(): void {
    this.viewport().nativeElement.removeEventListener('scroll', this.onScroll, true);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    cancelAnimationFrame(this.frame);
  }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.recompute());
  }

  /** Mede as posições reais dos pontos na tela: nada fica desenhado em posição fixa. */
  private recompute(): void {
    const viewportEl = this.viewport().nativeElement;
    const origin = viewportEl.getBoundingClientRect();
    const ports = {
      source: new Map<string, HTMLElement>(),
      target: new Map<string, HTMLElement>(),
    };
    viewportEl.querySelectorAll<HTMLElement>('.port').forEach((el) => {
      const side = el.dataset['portSide'] as Side;
      ports[side].set(el.dataset['portPath'] as string, el);
    });
    const anchor = (side: Side, path: string): { point: Point; approximate: boolean } | null => {
      const chain = ancestorChain(path);
      const scroller = viewportEl.querySelector<HTMLElement>(`[data-card-scroll="${side}"]`);
      if (!scroller) return null;
      const box = scroller.getBoundingClientRect();
      const x = side === 'source' ? box.right : box.left;
      for (const candidate of chain) {
        const el = ports[side].get(candidate);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const y = clamp(center, box.top, box.bottom);
        const hidden = center < box.top || center > box.bottom;
        // Termina na borda externa do ponto: o ponto continua livre para iniciar outro arrasto.
        const edge = hidden ? x : side === 'source' ? r.right : r.left;
        return {
          point: { x: edge - origin.left, y: y - origin.top },
          approximate: candidate !== path || hidden,
        };
      }
      // Campo que não existe na estrutura: a linha nasce no topo do cartão.
      return { point: { x: x - origin.left, y: box.top - origin.top + 8 }, approximate: true };
    };

    const selected = this.store.selectedMappingId();
    const lines: Line[] = [];
    for (const m of this.store.mappings()) {
      const b = anchor('target', m.targetPath);
      if (!b) continue;
      let a = m.sourcePath === '' ? null : anchor('source', m.sourcePath);
      if (!a) a = { point: { x: b.point.x - 90, y: b.point.y }, approximate: true };
      // Rótulo compacto evita a sobreposição; a conexão selecionada mostra as etapas por extenso.
      const label = m.id === selected ? stepsLabel(m) : compactLabel(m);
      lines.push({
        id: m.id,
        d: connectionPath(a.point, b.point),
        mid: connectionMiddle(a.point, b.point),
        status: m.validationStatus,
        selected: m.id === selected,
        approximate: a.approximate || b.approximate,
        label,
        labelWidth: label.length * 6.2 + 12,
        title: `${m.sourcePath || 'constante'} para ${m.targetPath}${stepsSuffix(m)}`,
      });
    }
    this.lines.set(lines);
  }

  // ------------------------------------------------------------------ zoom e pan

  protected zoomBy(factor: number, focus?: Point): void {
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    const point = focus ?? { x: rect.width / 2, y: rect.height / 2 };
    const scale = clamp(this.view().scale * factor, MIN_ZOOM, MAX_ZOOM);
    this.view.set(zoomAround(this.view(), scale, point));
  }

  protected fit(): void {
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const worldWidth = MARGIN * 2 + CARD_WIDTH * 2 + CARD_GAP;
    const scale = clamp(rect.width / worldWidth, MIN_ZOOM, 1);
    // Os cartões ocupam a altura disponível; quem tem mais campos rola por dentro.
    this.cardHeight.set(Math.max(240, (rect.height - 2 * MARGIN) / scale));
    this.view.set({ scale, x: Math.max(0, (rect.width - worldWidth * scale) / 2), y: MARGIN });
  }

  protected resetView(): void {
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    this.cardHeight.set(Math.max(240, rect.height - 2 * MARGIN));
    this.view.set({ x: 0, y: MARGIN, scale: 1 });
  }

  protected onWheel(event: WheelEvent): void {
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    } else if (!(event.target as HTMLElement).closest('.canvas-card')) {
      event.preventDefault();
      this.view.update((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    }
  }

  protected onBackgroundDown(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-card') || target.closest('.connection')) return;
    this.store.selectedMappingId.set(null);
    this.panStart = { x: event.clientX, y: event.clientY, vx: this.view().x, vy: this.view().y };
    this.panning.set(true);
    this.viewport().nativeElement.setPointerCapture?.(event.pointerId);
  }

  // ------------------------------------------------------------------ conexões

  protected onPortDown(e: PortEvent): void {
    const event = e.event as PointerEvent;
    event.preventDefault();
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    const portRect = (event.target as HTMLElement).getBoundingClientRect();
    const from = {
      x: portRect.left + portRect.width / 2 - rect.left,
      y: portRect.top + portRect.height / 2 - rect.top,
    };
    this.drag.set({ side: e.side, path: e.path, from, to: from, moved: false });
    this.viewport().nativeElement.setPointerCapture?.(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    const rect = this.viewport().nativeElement.getBoundingClientRect();
    if (this.panStart) {
      const { x, y, vx, vy } = this.panStart;
      this.view.update((v) => ({ ...v, x: vx + event.clientX - x, y: vy + event.clientY - y }));
      return;
    }
    const d = this.drag();
    if (d) {
      const to = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const moved = d.moved || Math.hypot(to.x - d.from.x, to.y - d.from.y) > 4;
      this.drag.set({ ...d, to, moved });
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    this.panStart = null;
    this.panning.set(false);
    const d = this.drag();
    if (!d) return;
    this.drag.set(null);
    this.viewport().nativeElement.releasePointerCapture?.(event.pointerId);
    if (!d.moved) {
      // Sem arrasto, é um clique: a captura do ponteiro pode ter engolido o evento de clique.
      this.handlePortActivated(d.side, d.path);
      this.suppressNextClick = true;
      return;
    }
    const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const row = el?.closest('.tree-row');
    const port = (el?.closest('.port') ?? row?.querySelector('.port')) as HTMLElement | null;
    if (!port) return;
    const side = port.dataset['portSide'] as Side;
    const path = port.dataset['portPath'] as string;
    if (side !== d.side) this.connect(d.side, d.path, path);
  }

  private suppressNextClick = false;

  protected onPortClick(e: PortEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    this.handlePortActivated(e.side, e.path);
  }

  private handlePortActivated(side: Side, path: string): void {
    const armed = this.state.armed();
    if (armed && armed.side !== side) {
      this.connect(armed.side, armed.path, path);
      this.state.armed.set(null);
    } else if (armed && armed.side === side && armed.path === path) {
      this.state.armed.set(null);
    } else {
      this.state.armed.set({ side, path });
    }
  }

  private connect(side: Side, first: string, second: string): void {
    const source = side === 'source' ? first : second;
    const target = side === 'source' ? second : first;
    const created = this.store.addMapping(source, target);
    if (created) this.state.showDock('properties');
  }

  protected cancelPointer(): void {
    this.drag.set(null);
    this.panStart = null;
    this.panning.set(false);
  }

  protected tempPath(d: Drag): string {
    return d.side === 'source' ? connectionPath(d.from, d.to) : connectionPath(d.to, d.from);
  }

  protected select(event: Event, id: string): void {
    event.stopPropagation();
    this.store.selectedMappingId.set(id);
    this.state.showDock('properties');
  }

  protected remove(event: Event, id: string): void {
    event.stopPropagation();
    this.store.removeMapping(id);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.state.armed() || this.drag()) {
      this.state.armed.set(null);
      this.drag.set(null);
    } else {
      this.store.selectedMappingId.set(null);
    }
  }
}

function activeNames(m: Mapping): string[] {
  return m.transforms
    .filter((t) => !t.disabled)
    .map((t) => getTransform(t.transformId)?.label ?? t.transformId);
}

function compactLabel(m: Mapping): string {
  const n = activeNames(m).length;
  return n === 0 ? '' : `ƒ${n}`;
}

function stepsSuffix(m: Mapping): string {
  const names = activeNames(m);
  return names.length ? `, com ${names.join(', ')}` : '';
}

function stepsLabel(m: Mapping): string {
  const names = activeNames(m);
  if (names.length === 0) return '';
  const text = names.join(' → ');
  return text.length > 40 ? `${names.length} transformações` : text;
}
