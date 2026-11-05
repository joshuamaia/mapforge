import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injectable,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { SettingsService } from '../../core/services/settings.service';

/* Tipos mínimos do Monaco: a biblioteca é carregada sob demanda, do próprio site. */
interface MonacoModel {
  getValue(): string;
  setValue(v: string): void;
}
interface MonacoEditorInstance {
  getValue(): string;
  setValue(v: string): void;
  getModel(): MonacoModel | null;
  onDidChangeModelContent(fn: () => void): { dispose(): void };
  updateOptions(o: Record<string, unknown>): void;
  revealLineInCenter(line: number): void;
  setPosition(p: { lineNumber: number; column: number }): void;
  focus(): void;
  dispose(): void;
}
interface MonacoApi {
  editor: {
    create(el: HTMLElement, options: Record<string, unknown>): MonacoEditorInstance;
    setTheme(name: string): void;
    defineTheme(name: string, data: Record<string, unknown>): void;
    setModelMarkers(model: MonacoModel, owner: string, markers: Record<string, unknown>[]): void;
    setModelLanguage(model: MonacoModel, language: string): void;
  };
  MarkerSeverity: { Error: number };
}

interface AmdWindow {
  require: {
    config(c: Record<string, unknown>): void;
    (deps: string[], ok: () => void, fail: (e: unknown) => void): void;
  };
  monaco: MonacoApi;
}

@Injectable({ providedIn: 'root' })
export class MonacoLoader {
  private promise: Promise<MonacoApi> | null = null;

  load(): Promise<MonacoApi> {
    this.promise ??= new Promise<MonacoApi>((resolve, reject) => {
      const base = new URL('assets/monaco/vs', document.baseURI).href;
      const script = document.createElement('script');
      script.src = `${base}/loader.js`;
      script.onerror = () => reject(new Error('Não foi possível carregar o editor Monaco.'));
      script.onload = () => {
        const w = window as unknown as AmdWindow;
        w.require.config({ paths: { vs: base } });
        w.require(
          ['vs/editor/editor.main'],
          () => {
            w.monaco.editor.defineTheme('mapforge-dark', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: { 'editor.background': '#12161e', 'editorGutter.background': '#12161e' },
            });
            w.monaco.editor.defineTheme('mapforge-light', {
              base: 'vs',
              inherit: true,
              rules: [],
              colors: { 'editor.background': '#ffffff' },
            });
            resolve(w.monaco);
          },
          (e) => reject(e instanceof Error ? e : new Error(String(e))),
        );
      };
      document.head.appendChild(script);
    });
    return this.promise;
  }
}

/** Editor de código. Sem Monaco disponível, cai para uma textarea e continua funcional. */
@Component({
  selector: 'mf-monaco-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (fallback()) {
      <textarea
        class="editor-fallback"
        [value]="value()"
        [readOnly]="readOnly()"
        [attr.aria-label]="label()"
        (input)="onFallback($event)"
      ></textarea>
    } @else {
      <div
        class="editor-host"
        #host
        [attr.data-testid]="testId()"
        [attr.aria-label]="label()"
      ></div>
      @if (loading()) {
        <div class="editor-loading" role="status">
          <span class="spinner"></span> Carregando editor…
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      height: 100%;
      min-height: 80px;
      overflow: hidden;
    }
    .editor-host {
      position: absolute;
      inset: 0;
    }
    .editor-fallback {
      width: 100%;
      height: 100%;
      resize: none;
      border: 0;
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      color: var(--text);
      padding: 8px;
    }
    .editor-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--text-muted);
      font-size: 12px;
      background: var(--code-bg);
    }
  `,
})
export class MonacoEditorComponent implements AfterViewInit, OnDestroy {
  readonly value = input('');
  readonly language = input('json');
  readonly readOnly = input(false);
  readonly label = input('Editor de código');
  readonly testId = input<string | null>(null);
  /** Linha com erro, marcada no editor. */
  readonly errorMarker = input<{ line?: number; column?: number; message: string } | null>(null);
  readonly valueChange = output<string>();

  protected readonly loading = signal(true);
  protected readonly fallback = signal(false);
  private readonly host = viewChild<ElementRef<HTMLElement>>('host');
  private readonly loader = inject(MonacoLoader);
  private readonly settings = inject(SettingsService);
  private editor: MonacoEditorInstance | null = null;
  private api: MonacoApi | null = null;
  private destroyed = false;
  private applying = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const value = this.value();
      if (this.editor && this.editor.getValue() !== value) {
        // Texto vindo de fora (undo, exemplo, importação) não é ecoado de volta.
        this.applying = true;
        this.editor.setValue(value);
        this.applying = false;
      }
    });
    effect(() => {
      const language = this.language();
      const model = this.editor?.getModel();
      if (model) this.api?.editor.setModelLanguage(model, language);
    });
    effect(() => {
      const theme = this.settings.theme();
      this.api?.editor.setTheme(theme === 'dark' ? 'mapforge-dark' : 'mapforge-light');
    });
    effect(() => {
      const marker = this.errorMarker();
      this.applyMarker(marker);
    });
    effect(() => {
      const readOnly = this.readOnly();
      this.editor?.updateOptions({ readOnly });
    });
  }

  ngAfterViewInit(): void {
    this.loader
      .load()
      .then((api) => {
        const host = this.host();
        if (this.destroyed || !host) return;
        this.api = api;
        this.editor = api.editor.create(host.nativeElement, {
          value: this.value(),
          language: this.language(),
          readOnly: this.readOnly(),
          theme: this.settings.theme() === 'dark' ? 'mapforge-dark' : 'mapforge-light',
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'on',
          renderLineHighlight: 'none',
          fixedOverflowWidgets: true,
          ariaLabel: this.label(),
        });
        this.editor.onDidChangeModelContent(() => {
          if (this.applying) return;
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(
            () => this.valueChange.emit(this.editor?.getValue() ?? ''),
            200,
          );
        });
        this.applyMarker(this.errorMarker());
        this.loading.set(false);
      })
      .catch(() => {
        this.fallback.set(true);
        this.loading.set(false);
      });
  }

  private applyMarker(marker: { line?: number; column?: number; message: string } | null): void {
    const model = this.editor?.getModel();
    if (!model || !this.api) return;
    const markers = marker?.line
      ? [
          {
            severity: this.api.MarkerSeverity.Error,
            message: marker.message,
            startLineNumber: marker.line,
            startColumn: marker.column ?? 1,
            endLineNumber: marker.line,
            endColumn: (marker.column ?? 1) + 1,
          },
        ]
      : [];
    this.api.editor.setModelMarkers(model, 'mapforge', markers);
  }

  /** Leva o cursor até a linha do erro. */
  reveal(line: number, column = 1): void {
    this.editor?.revealLineInCenter(line);
    this.editor?.setPosition({ lineNumber: line, column });
    this.editor?.focus();
  }

  protected onFallback(event: Event): void {
    this.valueChange.emit((event.target as HTMLTextAreaElement).value);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.debounce) {
      clearTimeout(this.debounce);
      // Não perde o que foi digitado imediatamente antes de sair da tela.
      const current = this.editor?.getValue();
      if (current !== undefined && current !== this.value()) this.valueChange.emit(current);
    }
    this.editor?.dispose();
  }
}
