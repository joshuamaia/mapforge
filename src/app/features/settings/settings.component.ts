import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  AppSettings,
  parseSynonymText,
  SettingsService,
} from '../../core/services/settings.service';
import { ConfirmService, ToastService } from '../../core/services/ui.services';
import { ProjectStore } from '../../core/services/project-store.service';
import { DEFAULT_SYNONYMS } from '../../core/smart-mapping/synonyms';

@Component({
  selector: 'mf-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page page-narrow">
      <header class="page-header">
        <div>
          <h1>Settings</h1>
          <p class="muted">As preferências ficam neste navegador.</p>
        </div>
      </header>

      <section class="card form-card">
        <h2>Aparência</h2>
        <div class="field">
          <label for="set-theme">Tema</label>
          <select
            id="set-theme"
            data-testid="set-theme"
            (change)="patch('theme', $any($event.target).value)"
          >
            <option value="dark" [selected]="s().theme === 'dark'">Escuro</option>
            <option value="light" [selected]="s().theme === 'light'">Claro</option>
          </select>
        </div>
      </section>

      <section class="card form-card">
        <h2>Limites e desempenho</h2>
        <div class="field-row">
          <div class="field">
            <label for="set-size">Tamanho máximo (MB)</label>
            <input
              id="set-size"
              type="number"
              min="1"
              max="100"
              data-testid="set-size"
              [value]="s().maxSizeMb"
              (change)="patchNumber('maxSizeMb', $any($event.target).value, 1, 100)"
            />
          </div>
          <div class="field">
            <label for="set-depth">Profundidade máxima</label>
            <input
              id="set-depth"
              type="number"
              min="2"
              max="256"
              data-testid="set-depth"
              [value]="s().maxDepth"
              (change)="patchNumber('maxDepth', $any($event.target).value, 2, 256)"
            />
          </div>
          <div class="field">
            <label for="set-debounce">Atraso do preview (ms)</label>
            <input
              id="set-debounce"
              type="number"
              min="0"
              max="5000"
              [value]="s().previewDebounceMs"
              (change)="patchNumber('previewDebounceMs', $any($event.target).value, 0, 5000)"
            />
          </div>
          <div class="field">
            <label for="set-timeout">Tempo limite de execução (ms)</label>
            <input
              id="set-timeout"
              type="number"
              min="500"
              max="120000"
              [value]="s().engineTimeoutMs"
              (change)="patchNumber('engineTimeoutMs', $any($event.target).value, 500, 120000)"
            />
          </div>
        </div>
        <small class="muted"
          >Arquivos e textos acima desses limites são recusados com uma mensagem, sem travar a
          interface.</small
        >
      </section>

      <section class="card form-card">
        <h2>Smart Mapping</h2>
        <label class="inline-check"
          ><input
            type="checkbox"
            [checked]="s().useBuiltInSynonyms"
            (change)="patch('useBuiltInSynonyms', $any($event.target).checked)"
          />Usar os {{ builtIn }} grupos de sinônimos português e inglês já incluídos</label
        >
        <div class="field">
          <label for="set-synonyms">Sinônimos adicionais</label>
          <textarea
            id="set-synonyms"
            rows="6"
            class="mono"
            spellcheck="false"
            data-testid="set-synonyms"
            placeholder="apelido, nickname&#10;~matricula, id"
            [value]="s().customSynonyms"
            (change)="patch('customSynonyms', $any($event.target).value)"
          ></textarea>
          <small class="muted"
            >Um grupo por linha, separado por vírgulas. Comece a linha com ~ para um grupo fraco,
            que limita a sugestão à confiança baixa. {{ customCount() }} grupo(s) válido(s).</small
          >
        </div>
      </section>

      <section class="card form-card">
        <h2>Geração de código</h2>
        <div class="field">
          <label for="set-package">Package Java padrão de novos projetos</label>
          <input
            id="set-package"
            class="mono"
            spellcheck="false"
            [value]="s().defaultJavaPackage"
            (change)="patch('defaultJavaPackage', $any($event.target).value)"
          />
        </div>
        <label class="inline-check"
          ><input
            type="checkbox"
            [checked]="s().defaultComments"
            (change)="patch('defaultComments', $any($event.target).checked)"
          />Incluir comentários explicativos em novos projetos</label
        >
      </section>

      <section class="card form-card">
        <h2>Dados locais</h2>
        <p class="muted small">
          O histórico de execuções guarda apenas contagens e tempos, nunca os dados processados.
        </p>
        <div class="row">
          <button class="btn" type="button" (click)="clearHistory()">
            Limpar histórico de execuções
          </button>
          <button class="btn" type="button" data-testid="reset-settings" (click)="resetSettings()">
            Restaurar padrões
          </button>
        </div>
      </section>
    </div>
  `,
})
export class SettingsComponent {
  private readonly settings = inject(SettingsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly store = inject(ProjectStore);
  protected readonly s = this.settings.settings;
  protected readonly builtIn = DEFAULT_SYNONYMS.length;
  protected readonly customCount = computed(() => parseSynonymText(this.s().customSynonyms).length);

  protected patch<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings.update({ [key]: value } as Partial<AppSettings>);
  }

  protected patchNumber(
    key: 'maxSizeMb' | 'maxDepth' | 'previewDebounceMs' | 'engineTimeoutMs',
    raw: string,
    min: number,
    max: number,
  ): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    this.patch(key, Math.min(max, Math.max(min, Math.round(n))));
  }

  protected async clearHistory(): Promise<void> {
    const yes = await this.confirm.confirm({
      title: 'Limpar histórico',
      message: 'O histórico de execuções de todos os projetos será apagado.',
      confirmLabel: 'Limpar',
      danger: true,
    });
    if (!yes) return;
    await this.store.repository.clearExecutions();
    this.store.libraryVersion.update((v) => v + 1);
    this.toasts.success('Histórico apagado.');
  }

  protected async resetSettings(): Promise<void> {
    const yes = await this.confirm.confirm({
      title: 'Restaurar padrões',
      message:
        'Limites, sinônimos adicionais e preferências de código voltam aos valores iniciais.',
      confirmLabel: 'Restaurar',
    });
    if (yes) {
      this.settings.reset();
      this.toasts.success('Padrões restaurados.');
    }
  }
}
