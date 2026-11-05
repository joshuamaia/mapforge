import { TestBed } from '@angular/core/testing';
import { EXAMPLES } from '../../core/examples/examples';
import { ProjectStore } from '../../core/services/project-store.service';
import { emptyDocument } from '../../core/models/project.model';
import { ConfirmService } from '../../core/services/ui.services';
import { FieldTreeComponent } from '../../shared/components/field-tree.component';
import {
  formatTable,
  parseLiteral,
  parseTable,
} from '../../shared/components/param-form.component';
import { computeMetrics } from '../dashboard/dashboard-metrics';
import {
  ancestorChain,
  clamp,
  connectionMiddle,
  connectionPath,
  zoomAround,
} from './mapping-canvas/connection-geometry';
import { deepEqual } from './preview-panel/preview-panel.component';
import { StudioState } from './studio-state.service';

async function storeWith(source: unknown, target: unknown): Promise<ProjectStore> {
  const store = TestBed.inject(ProjectStore);
  store.setStructureText('source', JSON.stringify(source));
  store.setStructureText('target', JSON.stringify(target));
  return store;
}

describe('ProjectStore', () => {
  it('cria mapeamento com os tipos das estruturas e não duplica', async () => {
    const store = await storeWith({ a: 'x' }, { b: 1 });
    const m = store.addMapping('a', 'b');
    expect(m).toMatchObject({ sourceType: 'string', targetType: 'integer' });
    store.addMapping('a', 'b');
    expect(store.document().mappings).toHaveLength(1);
    expect(store.selectedMappingId()).toBe(m?.id);
  });

  it('desfaz e refaz, mantendo a seleção coerente', async () => {
    const store = await storeWith({ a: 'x' }, { b: 'y' });
    store.addMapping('a', 'b');
    store.undo();
    expect(store.document().mappings).toHaveLength(0);
    expect(store.selectedMappingId()).toBeNull();
    store.redo();
    expect(store.document().mappings).toHaveLength(1);
  });

  it('agrupa digitação seguida em uma só entrada de undo', async () => {
    const store = TestBed.inject(ProjectStore);
    const initial = store.document().sampleData;
    store.setSampleData('{"a":1}');
    store.setSampleData('{"a":12}');
    store.setSampleData('{"a":123}');
    store.undo();
    expect(store.document().sampleData).toBe(initial);
  });

  it('dados de entrada acompanham o JSON de origem até serem editados à parte', async () => {
    const store = TestBed.inject(ProjectStore);
    store.updateDocument((d) => ({ ...d, sampleData: d.source.text }));
    store.setStructureText('source', '{"a":1}');
    expect(store.document().sampleData).toBe('{"a":1}');
    store.setSampleData('{"a":2}');
    store.setStructureText('source', '{"a":3}');
    expect(store.document().sampleData).toBe('{"a":2}');
  });

  it('reordena, atualiza e remove etapas', async () => {
    const store = await storeWith({ a: 'x' }, { b: 'y' });
    const id = store.addMapping('a', 'b')?.id as string;
    store.addStep(id, 'trim');
    store.addStep(id, 'uppercase');
    store.moveStep(id, 1, 0);
    const steps = () => store.document().mappings[0].transforms;
    expect(steps().map((s) => s.transformId)).toEqual(['uppercase', 'trim']);
    store.updateStep(id, steps()[0].id, { disabled: true });
    expect(steps()[0].disabled).toBe(true);
    store.removeStep(id, steps()[1].id);
    expect(steps()).toHaveLength(1);
    store.addStep(id, 'naoExiste');
    expect(steps()).toHaveLength(1);
  });

  it('calcula status e diagnósticos a partir do documento', async () => {
    const store = await storeWith({ a: true }, { b: { c: 1 } });
    store.addMapping('a', 'b');
    expect(store.mappings()[0].validationStatus).toBe('error');
    expect(store.errorCount()).toBeGreaterThan(0);
  });

  it('Smart Mapping: aceita, rejeita e em lote só a confiança alta', async () => {
    const store = await storeWith(
      { nome: 'a', codigoCliente: 1, ativo: true },
      { name: 'b', customerId: 2, enabled: false },
    );
    store.runSmartMapping();
    const ids = store
      .suggestions()
      .map((s) => s.targetPath)
      .sort();
    expect(ids).toEqual(['customerId', 'enabled', 'name']);
    store.rejectSuggestion(
      store.suggestions().find((s) => s.targetPath === 'enabled')?.id as string,
    );
    expect(store.acceptHighConfidence()).toBe(1);
    expect(store.document().mappings.map((m) => m.targetPath)).toEqual(['name']);
    expect(store.suggestions().map((s) => s.targetPath)).toEqual(['customerId']);
    store.runSmartMapping();
    expect(store.suggestions().map((s) => s.targetPath)).toEqual(['customerId']);
  });

  it('executa pela mesma API usada no preview', async () => {
    const store = TestBed.inject(ProjectStore);
    store.setSampleData('{"a":"x"}');
    store.addMapping('a', 'b');
    const result = await store.execute();
    expect(result?.output).toEqual({ b: 'x' });
    expect(store.preview()?.output).toEqual({ b: 'x' });
    store.setSampleData('{');
    expect(await store.execute()).toBeNull();
    expect(store.previewError()).toContain('JSON');
  });

  it('abrir exemplo pede confirmação quando há alterações e não altera a galeria', async () => {
    const store = TestBed.inject(ProjectStore);
    const confirm = TestBed.inject(ConfirmService);
    store.rename('alterado');
    const opening = store.openExample(EXAMPLES[0]);
    expect(confirm.pending()?.title).toContain('não salvas');
    confirm.answer('alternative');
    expect(await opening).toBe(true);
    expect(store.document().mappings).toHaveLength(EXAMPLES[0].document.mappings.length);
    expect(store.dirty()).toBe(false);
    store.removeMapping(store.document().mappings[0].id);
    expect(EXAMPLES[0].document.mappings).toHaveLength(8);
  });

  it('salva e recupera pelo IndexedDB', async () => {
    const store = TestBed.inject(ProjectStore);
    store.rename(`Projeto ${Date.now()}`);
    store.addMapping('a', 'b');
    await store.save();
    expect(store.dirty()).toBe(false);
    const saved = await store.repository.get(store.project().id);
    expect(saved?.document.mappings).toHaveLength(1);
    await store.repository.delete(store.project().id);
  });
});

describe('FieldTreeComponent', () => {
  function render(query = ''): { el: HTMLElement; detect: () => Promise<void> } {
    const state = TestBed.inject(StudioState);
    state.query.source.set(query);
    const store = TestBed.inject(ProjectStore);
    store.setStructureText(
      'source',
      JSON.stringify({ cliente: { nome: 'a', idade: 1 }, itens: [{ sku: 'x' }], tags: ['t'] }),
    );
    const fixture = TestBed.createComponent(FieldTreeComponent);
    fixture.componentRef.setInput('side', 'source');
    fixture.componentRef.setInput('root', store.sourceParsed().root);
    fixture.componentRef.setInput('ports', true);
    fixture.componentRef.setInput('testPrefix', 't');
    return { el: fixture.nativeElement, detect: () => fixture.whenStable() };
  }

  it('mostra hierarquia, tipos e pontos de conexão', async () => {
    const { el, detect } = render();
    await detect();
    expect(el.querySelector('[data-testid="t-row-cliente.nome"] .type-badge')?.textContent).toBe(
      'string',
    );
    expect(el.querySelector('[data-testid="t-row-itens"] .type-badge')?.textContent).toBe(
      'object[]',
    );
    expect(el.querySelector('.port[data-port-path="itens[*].sku"]')).not.toBeNull();
    expect(el.querySelector('.port[data-port-path="tags[*]"]')).not.toBeNull();
  });

  it('recolhe e expande', async () => {
    const { el, detect } = render();
    await detect();
    el.querySelector<HTMLButtonElement>('[data-testid="t-row-cliente"] .tree-chevron')?.click();
    await detect();
    expect(el.querySelector('[data-testid="t-row-cliente.nome"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="t-row-cliente"] .tree-chevron')?.click();
    await detect();
    expect(el.querySelector('[data-testid="t-row-cliente.nome"]')).not.toBeNull();
  });

  it('busca mantém os ancestrais e abre o que estiver recolhido', async () => {
    TestBed.inject(StudioState).toggleCollapsed('source', 'cliente');
    const { el, detect } = render('idade');
    await detect();
    expect(el.querySelector('[data-testid="t-row-cliente.idade"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="t-row-cliente"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="t-row-itens"]')).toBeNull();
  });

  it('o texto do JSON nunca vira HTML', async () => {
    const store = TestBed.inject(ProjectStore);
    store.setStructureText('source', JSON.stringify({ '<img src=x onerror=alert(1)>': 1 }));
    const fixture = TestBed.createComponent(FieldTreeComponent);
    fixture.componentRef.setInput('side', 'source');
    fixture.componentRef.setInput('root', store.sourceParsed().root);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.tree-name')?.textContent).toContain('<img');
  });
});

describe('funções de apoio da interface', () => {
  it('geometria das conexões', () => {
    expect(connectionPath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe('M 0 0 C 50 0, 50 50, 100 50');
    expect(connectionMiddle({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
    expect(ancestorChain('a.b[*].c')).toEqual(['a.b[*].c', 'a.b[*]', 'a.b', 'a']);
    expect(ancestorChain('a..b')).toEqual([]);
    expect(clamp(5, 0, 3)).toBe(3);
  });

  it('o zoom mantém o ponto sob o cursor', () => {
    const next = zoomAround({ x: 10, y: 20, scale: 1 }, 2, { x: 110, y: 120 });
    expect(next).toEqual({ scale: 2, x: -90, y: -80 });
    expect((110 - next.x) / next.scale).toBe((110 - 10) / 1);
  });

  it('literais e tabelas dos formulários', () => {
    expect(parseLiteral('10')).toBe(10);
    expect(parseLiteral('true')).toBe(true);
    expect(parseLiteral('"10"')).toBe('10');
    expect(parseLiteral('texto')).toBe('texto');
    expect(parseLiteral('')).toBeUndefined();
    expect(parseTable('A=1\nB=x\n\n__proto__=9\ninvalida')).toEqual({ A: 1, B: 'x' });
    expect(formatTable({ A: 1, B: 'x' })).toBe('A=1\nB=x');
  });

  it('comparação profunda ignora a ordem das chaves', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('indicadores do dashboard vêm dos dados reais', () => {
    const project = (id: string, favorite: boolean, doc = EXAMPLES[0].document) => ({
      id,
      name: id,
      description: '',
      favorite,
      createdAt: '2024-01-01',
      updatedAt: `2024-01-0${id}`,
      document: doc,
    });
    const m = computeMetrics(
      [
        project('1', true),
        project('2', false, EXAMPLES[7].document),
        project('3', false, emptyDocument()),
      ],
      [],
    );
    expect(m.totalProjects).toBe(3);
    expect(m.totalMappings).toBe(18);
    expect(m.favorites.map((p) => p.id)).toEqual(['1']);
    expect(m.withErrors.map((e) => e.project.id)).toEqual(['2']);
    expect(m.recentProjects[0].id).toBe('3');
    expect(m.topTransformations[0].count).toBeGreaterThan(0);
  });
});
