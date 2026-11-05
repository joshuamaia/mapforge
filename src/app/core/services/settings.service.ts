import { computed, effect, Injectable, signal } from '@angular/core';
import { ParseLimits } from '../parsers/json-parser';
import { DEFAULT_SYNONYMS, SynonymGroup } from '../smart-mapping/synonyms';

export type ThemeMode = 'dark' | 'light';

export interface AppSettings {
  theme: ThemeMode;
  previewDebounceMs: number;
  maxSizeMb: number;
  maxDepth: number;
  engineTimeoutMs: number;
  /** Sinônimos adicionais, uma linha por grupo, separados por vírgula. `~` marca grupo fraco. */
  customSynonyms: string;
  useBuiltInSynonyms: boolean;
  defaultJavaPackage: string;
  defaultComments: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  previewDebounceMs: 400,
  maxSizeMb: 5,
  maxDepth: 32,
  engineTimeoutMs: 10000,
  customSynonyms: '',
  useBuiltInSynonyms: true,
  defaultJavaPackage: 'com.example.mapping',
  defaultComments: true,
};

const STORAGE_KEY = 'mapforge.settings';

export function parseSynonymText(text: string): SynonymGroup[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const weak = line.startsWith('~');
      const terms = (weak ? line.slice(1) : line)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      return weak ? { terms, weak } : { terms };
    })
    .filter((group) => group.terms.length >= 2);
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly state = signal<AppSettings>(this.load());

  readonly settings = this.state.asReadonly();
  readonly theme = computed(() => this.state().theme);
  readonly limits = computed<ParseLimits>(() => ({
    maxBytes: this.state().maxSizeMb * 1024 * 1024,
    maxDepth: this.state().maxDepth,
  }));
  readonly synonyms = computed<SynonymGroup[]>(() => [
    ...(this.state().useBuiltInSynonyms ? DEFAULT_SYNONYMS : []),
    ...parseSynonymText(this.state().customSynonyms),
  ]);

  constructor() {
    effect(() => {
      const s = this.state();
      document.documentElement.dataset['theme'] = s.theme;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      } catch {
        // Armazenamento indisponível: as preferências valem só para esta sessão.
      }
    });
  }

  update(patch: Partial<AppSettings>): void {
    this.state.update((s) => ({ ...s, ...patch }));
  }

  toggleTheme(): void {
    this.update({ theme: this.state().theme === 'dark' ? 'light' : 'dark' });
  }

  reset(): void {
    this.state.set({ ...DEFAULT_SETTINGS, theme: this.state().theme });
  }

  private load(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      // Valor corrompido ou armazenamento bloqueado: usa os padrões.
    }
    return { ...DEFAULT_SETTINGS };
  }
}
