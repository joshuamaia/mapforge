import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { ProjectStore } from './core/services/project-store.service';
import { SettingsService } from './core/services/settings.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), provideLocationMocks()],
    }).compileComponents();
  });

  it('mostra as ações do header e os sete itens da sidebar', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const buttons = [...el.querySelectorAll('.header-actions .btn')].map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).toEqual(['New Mapping', 'Open', 'Save', 'Import', 'Export']);
    const links = [...el.querySelectorAll('.app-nav a')].map((a) => a.textContent?.trim());
    expect(links).toEqual([
      'Dashboard',
      'Mapping Studio',
      'Transformations',
      'Code Generator',
      'Examples',
      'Saved Projects',
      'Settings',
    ]);
  });

  it('indica alterações não salvas', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="dirty"]')).toBeNull();
    TestBed.inject(ProjectStore).rename('Outro nome');
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="dirty"]')).not.toBeNull();
  });

  it('alterna o tema pelo botão', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const settings = TestBed.inject(SettingsService);
    const initial = settings.theme();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="theme-toggle"]')
      ?.click();
    await fixture.whenStable();
    expect(settings.theme()).not.toBe(initial);
    expect(document.documentElement.dataset['theme']).toBe(settings.theme());
    settings.toggleTheme();
  });

  it('atalhos de desfazer não interferem em campos de texto', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const store = TestBed.inject(ProjectStore);
    store.addMapping('a', 'b');
    const input = (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(store.document().mappings).toHaveLength(1);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
    expect(store.document().mappings).toHaveLength(0);
  });
});
