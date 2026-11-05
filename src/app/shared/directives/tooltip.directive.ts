import { ConnectedPosition, Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  signal,
} from '@angular/core';

@Component({
  selector: 'mf-tooltip-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="tooltip-bubble" role="tooltip">{{ text() }}</div>`,
})
export class TooltipBubbleComponent {
  readonly text = signal('');
}

const POSITIONS: ConnectedPosition[] = [
  { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 6 },
  { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -6 },
];

/** Dica acessível: aparece com mouse e com foco de teclado. O texto é sempre interpolado, nunca HTML. */
@Directive({
  selector: '[mfTooltip]',
  host: { '[attr.aria-label]': 'ariaLabel() ?? mfTooltip()' },
})
export class TooltipDirective implements OnDestroy {
  readonly mfTooltip = input.required<string>();
  readonly ariaLabel = input<string | undefined>(undefined);

  private readonly overlay = inject(Overlay);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private ref: OverlayRef | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('mouseenter')
  @HostListener('focusin')
  protected show(): void {
    if (this.ref || !this.mfTooltip()) return;
    this.timer = setTimeout(() => {
      const ref = this.overlay.create({
        positionStrategy: this.overlay
          .position()
          .flexibleConnectedTo(this.host)
          .withPositions(POSITIONS)
          .withPush(true),
        scrollStrategy: this.overlay.scrollStrategies.close(),
      });
      const instance = ref.attach(new ComponentPortal(TooltipBubbleComponent)).instance;
      instance.text.set(this.mfTooltip());
      this.ref = ref;
    }, 350);
  }

  @HostListener('mouseleave')
  @HostListener('focusout')
  @HostListener('click')
  @HostListener('document:keydown.escape')
  protected hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ref?.dispose();
    this.ref = null;
  }

  ngOnDestroy(): void {
    this.hide();
  }
}
