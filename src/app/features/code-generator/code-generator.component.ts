import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  CODE_TARGETS,
  generateCode,
  GeneratedFile,
  GeneratedOutput,
} from '../../core/code-generators';
import { CodegenSettings } from '../../core/models/project.model';
import { downloadText, ProjectStore } from '../../core/services/project-store.service';
import { ToastService } from '../../core/services/ui.services';
import { IconComponent } from '../../shared/components/icon.component';
import { MonacoEditorComponent } from '../../shared/components/monaco-editor.component';

/** Formata TypeScript com Prettier, carregado só quando esta tela é usada. */
async function formatTypeScript(code: string): Promise<string> {
  const [prettier, ts, estree] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/typescript'),
    import('prettier/plugins/estree'),
  ]);
  return prettier.format(code, {
    parser: 'typescript',
    plugins: [ts.default ?? ts, estree.default ?? estree],
    singleQuote: true,
    printWidth: 100,
  });
}

@Component({
  selector: 'mf-code-generator',
  imports: [IconComponent, MonacoEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page page-code">
      <header class="page-header">
        <div>
          <h1>Code Generator</h1>
          <p class="muted">
            Gera código a partir de <strong>{{ store.project().name }}</strong
            >, com {{ store.mappings().length }} mapeamentos.
          </p>
        </div>
      </header>
      <div class="code-options">
        <div class="code-targets" role="radiogroup" aria-label="Tipo de código">
          @for (t of targets; track t.id) {
            <button
              type="button"
              class="target-option"
              role="radio"
              [attr.aria-checked]="settings().target === t.id"
              [attr.data-testid]="'target-' + t.id"
              (click)="patch({ target: t.id })"
            >
              <strong>{{ t.label }}</strong>
              <span>{{ t.description }}</span>
            </button>
          }
        </div>
        <div class="code-fields">
          <div class="field">
            <label for="code-name">Nome</label>
            <input
              id="code-name"
              data-testid="code-name"
              spellcheck="false"
              [value]="settings().mapperName"
              (input)="patch({ mapperName: $any($event.target).value })"
            />
          </div>
          <div class="field">
            <label for="code-package">Package Java</label>
            <input
              id="code-package"
              class="mono"
              data-testid="code-package"
              spellcheck="false"
              [disabled]="!isJava()"
              [value]="settings().javaPackage"
              (input)="patch({ javaPackage: $any($event.target).value })"
            />
            @if (packageError()) {
              <small class="text-error">Package inválido: use letras, números e pontos.</small>
            }
          </div>
          <label class="inline-check"
            ><input
              type="checkbox"
              data-testid="code-comments"
              [checked]="settings().comments"
              (change)="patch({ comments: $any($event.target).checked })"
            />Comentários explicativos</label
          >
        </div>
      </div>
      @if (output().warnings.length) {
        <div class="notice notice-warning" role="status" data-testid="code-warnings">
          <strong><mf-icon name="warning" [size]="14" /> O código gerado não cobre tudo</strong>
          <ul>
            @for (w of output().warnings; track w) {
              <li>{{ w }}</li>
            }
          </ul>
        </div>
      }
      @if (files().length) {
        <div class="code-preview">
          <div class="tabs code-tabs" role="tablist" aria-label="Arquivos gerados">
            @for (f of files(); track f.name; let i = $index) {
              <button
                role="tab"
                type="button"
                [attr.aria-selected]="i === activeIndex()"
                [attr.data-testid]="'file-' + f.name"
                (click)="activeIndex.set(i)"
              >
                {{ f.name }}
              </button>
            }
            <span class="spacer"></span>
            @if (formatting()) {
              <span class="muted small" role="status"
                ><span class="spinner"></span> Formatando…</span
              >
            }
            <button class="btn btn-sm" type="button" data-testid="code-copy" (click)="copy()">
              <mf-icon name="copy" [size]="14" />Copy
            </button>
            <button
              class="btn btn-sm"
              type="button"
              data-testid="code-download"
              (click)="download()"
            >
              <mf-icon name="download" [size]="14" />Download
            </button>
          </div>
          <div class="code-editor">
            <mf-monaco-editor
              testId="code-editor"
              label="Prévia do código gerado"
              [readOnly]="true"
              [value]="active()?.content ?? ''"
              [language]="active()?.language ?? 'typescript'"
            />
          </div>
        </div>
      } @else {
        <div class="empty-state"><p>Informe estruturas válidas para gerar código.</p></div>
      }
    </div>
  `,
})
export class CodeGeneratorComponent {
  protected readonly store = inject(ProjectStore);
  private readonly toasts = inject(ToastService);
  protected readonly targets = CODE_TARGETS;
  protected readonly settings = computed(() => this.store.document().codegen);
  protected readonly isJava = computed(
    () => CODE_TARGETS.find((t) => t.id === this.settings().target)?.language === 'java',
  );
  protected readonly packageError = computed(() => {
    const pkg = this.settings().javaPackage;
    return this.isJava() && pkg !== '' && !/^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*$/.test(pkg);
  });
  protected readonly activeIndex = signal(0);
  protected readonly formatting = signal(false);

  protected readonly output = computed<GeneratedOutput>(() => {
    try {
      return generateCode(this.store.document());
    } catch (e) {
      return {
        files: [],
        warnings: [`Falha ao gerar o código: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
  });
  protected readonly files = signal<GeneratedFile[]>([]);
  protected readonly active = computed<GeneratedFile | undefined>(
    () => this.files()[Math.min(this.activeIndex(), this.files().length - 1)],
  );
  private seq = 0;

  constructor() {
    effect(() => {
      const out = this.output();
      untracked(() => {
        this.files.set(out.files);
        void this.applyFormatting(out.files);
      });
    });
  }

  private async applyFormatting(files: GeneratedFile[]): Promise<void> {
    if (!files.some((f) => f.language === 'typescript')) return;
    const seq = ++this.seq;
    this.formatting.set(true);
    try {
      const formatted = await Promise.all(
        files.map(async (f) =>
          f.language === 'typescript' ? { ...f, content: await formatTypeScript(f.content) } : f,
        ),
      );
      if (seq === this.seq) this.files.set(formatted);
    } catch {
      // Sem Prettier, o código segue com a indentação do próprio gerador.
    } finally {
      if (seq === this.seq) this.formatting.set(false);
    }
  }

  protected patch(patch: Partial<CodegenSettings>): void {
    if (patch.target) this.activeIndex.set(0);
    this.store.updateDocument(
      (doc) => ({ ...doc, codegen: { ...doc.codegen, ...patch } }),
      `codegen:${Object.keys(patch).join()}`,
    );
  }

  protected async copy(): Promise<void> {
    const file = this.active();
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      this.toasts.success(`${file.name} copiado.`);
    } catch {
      this.toasts.error('O navegador não permitiu copiar.');
    }
  }

  protected download(): void {
    const file = this.active();
    if (file) downloadText(file.name, file.content, 'text/plain');
  }
}
