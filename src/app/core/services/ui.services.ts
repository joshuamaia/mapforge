import { ErrorHandler, inject, Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  readonly toasts = signal<Toast[]>([]);

  show(kind: ToastKind, message: string, durationMs = kind === 'error' ? 7000 : 3500): void {
    const id = ++this.seq;
    this.toasts.update((list) => [...list.slice(-4), { id, kind, message }]);
    setTimeout(() => this.dismiss(id), durationMs);
  }

  success(message: string): void {
    this.show('success', message);
  }

  error(message: string): void {
    this.show('error', message);
  }

  info(message: string): void {
    this.show('info', message);
  }

  warning(message: string): void {
    this.show('warning', message);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Terceira opção, devolvida como `'alternative'`. */
  alternativeLabel?: string;
  danger?: boolean;
}

export type ConfirmResult = 'confirm' | 'cancel' | 'alternative';

interface PendingConfirm extends ConfirmOptions {
  resolve: (result: ConfirmResult) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  /** Abre o diálogo e resolve com a escolha. Cancelar é o padrão de qualquer outra saída. */
  ask(options: ConfirmOptions): Promise<ConfirmResult> {
    this.pending()?.resolve('cancel');
    return new Promise((resolve) => this.pending.set({ ...options, resolve }));
  }

  async confirm(options: ConfirmOptions): Promise<boolean> {
    return (await this.ask(options)) === 'confirm';
  }

  answer(result: ConfirmResult): void {
    const current = this.pending();
    this.pending.set(null);
    current?.resolve(result);
  }
}

/** Erros não tratados viram um aviso na tela; os detalhes ficam só no console local. */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly toasts = inject(ToastService);
  private lastMessage = '';
  private lastAt = 0;

  handleError(error: unknown): void {
    console.error(error);
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    const now = Date.now();
    if (message === this.lastMessage && now - this.lastAt < 3000) return;
    this.lastMessage = message;
    this.lastAt = now;
    this.toasts.error(`Erro inesperado: ${message}`);
  }
}
