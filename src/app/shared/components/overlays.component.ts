import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  input,
  output,
} from '@angular/core';
import { ConfirmService, ToastService } from '../../core/services/ui.services';
import { IconComponent } from './icon.component';

const TOAST_ICONS: Record<string, string> = {
  success: 'check',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

@Component({
  selector: 'mf-toasts',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toasts" role="status" aria-live="polite">
      @for (t of service.toasts(); track t.id) {
        <div class="toast" [class]="'toast toast-' + t.kind" data-testid="toast">
          <mf-icon [name]="icon(t.kind)" />
          <span>{{ t.message }}</span>
          <button
            class="btn-icon"
            type="button"
            aria-label="Fechar aviso"
            (click)="service.dismiss(t.id)"
          >
            <mf-icon name="close" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastsComponent {
  protected readonly service = inject(ToastService);
  protected icon(kind: string): string {
    return TOAST_ICONS[kind] ?? 'info';
  }
}

@Component({
  selector: 'mf-confirm-dialog',
  imports: [A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (service.pending(); as dialog) {
      <div class="dialog-backdrop" (click)="service.answer('cancel')">
        <div
          class="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
          cdkTrapFocus
          [cdkTrapFocusAutoCapture]="true"
          (click)="$event.stopPropagation()"
        >
          <h2 id="confirm-title">{{ dialog.title }}</h2>
          <p id="confirm-message">{{ dialog.message }}</p>
          <div class="dialog-actions">
            <button class="btn" type="button" cdkFocusInitial (click)="service.answer('cancel')">
              {{ dialog.cancelLabel ?? 'Cancelar' }}
            </button>
            @if (dialog.alternativeLabel) {
              <button class="btn" type="button" (click)="service.answer('alternative')">
                {{ dialog.alternativeLabel }}
              </button>
            }
            <button
              class="btn"
              [class.btn-danger]="dialog.danger"
              [class.btn-primary]="!dialog.danger"
              type="button"
              data-testid="confirm-yes"
              (click)="service.answer('confirm')"
            >
              {{ dialog.confirmLabel ?? 'Confirmar' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  protected readonly service = inject(ConfirmService);

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.service.pending()) this.service.answer('cancel');
  }
}

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl + S', action: 'Salvar projeto' },
  { keys: 'Ctrl + Z', action: 'Desfazer' },
  { keys: 'Ctrl + Y ou Ctrl + Shift + Z', action: 'Refazer' },
  { keys: 'Ctrl + Enter', action: 'Run Mapping' },
  { keys: 'Delete', action: 'Remover a conexão selecionada' },
  { keys: 'Esc', action: 'Cancelar a conexão em andamento ou limpar a seleção' },
  { keys: 'Enter no ponto de um campo', action: 'Inicia ou conclui uma conexão pelo teclado' },
  { keys: 'Ctrl + roda do mouse', action: 'Zoom no canvas' },
  { keys: '?', action: 'Mostrar esta ajuda' },
];

@Component({
  selector: 'mf-shortcuts-dialog',
  imports: [A11yModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="dialog-backdrop" (click)="closed.emit()">
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
          cdkTrapFocus
          [cdkTrapFocusAutoCapture]="true"
          (click)="$event.stopPropagation()"
        >
          <div class="row-between">
            <h2 id="shortcuts-title">Atalhos de teclado</h2>
            <button class="btn-icon" type="button" aria-label="Fechar" (click)="closed.emit()">
              <mf-icon name="close" />
            </button>
          </div>
          <table class="table">
            <tbody>
              @for (s of shortcuts; track s.keys) {
                <tr>
                  <td>
                    <kbd>{{ s.keys }}</kbd>
                  </td>
                  <td>{{ s.action }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }
  `,
})
export class ShortcutsDialogComponent {
  readonly open = input(false);
  readonly closed = output<void>();
  protected readonly shortcuts = SHORTCUTS;
}
