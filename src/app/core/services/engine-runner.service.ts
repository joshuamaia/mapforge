import { inject, Injectable } from '@angular/core';
import { EngineInput, executeMappings } from '../mapping-engine/engine';
import { ExecutionResult } from '../models/execution.model';
import { SettingsService } from './settings.service';

interface Pending {
  resolve: (r: ExecutionResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Roda o motor em um Web Worker com tempo limite. Sem suporte a Worker, roda na thread principal. */
@Injectable({ providedIn: 'root' })
export class EngineRunner {
  private readonly settings = inject(SettingsService);
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  run(input: EngineInput): Promise<ExecutionResult> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(executeMappings(input));
    const id = ++this.seq;
    return new Promise<ExecutionResult>((resolve, reject) => {
      const timeout = this.settings.settings().engineTimeoutMs;
      const timer = setTimeout(() => {
        this.reset(
          new Error(
            `A execução foi interrompida após ${timeout / 1000}s. Verifique expressões regulares e o tamanho dos dados.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      // Estrutura serializada: o worker não recebe referências dos sinais.
      worker.postMessage({ id, input: JSON.parse(JSON.stringify(input)) as EngineInput });
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      const worker = new Worker(new URL('../mapping-engine/engine.worker', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (
        e: MessageEvent<{ id: number; result?: ExecutionResult; error?: string }>,
      ) => {
        const entry = this.pending.get(e.data.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(e.data.id);
        if (e.data.result) entry.resolve(e.data.result);
        else entry.reject(new Error(e.data.error ?? 'Falha na execução.'));
      };
      worker.onerror = (e) => this.reset(new Error(e.message || 'Falha no worker de execução.'));
      this.worker = worker;
      return worker;
    } catch {
      return null;
    }
  }

  /** Encerra o worker travado; o próximo pedido cria outro. */
  private reset(reason: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }
}
