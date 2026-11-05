import 'fake-indexeddb/auto';
import { emptyDocument, MapForgeProject } from '../models/project.model';
import {
  FORMAT_VERSION,
  parseProjectFile,
  ProjectImportError,
  projectFileName,
  serializeProject,
  toProjectFile,
} from './project-file';
import { ProjectRepository } from './project-repository';

const project = (over: Partial<MapForgeProject> = {}): MapForgeProject => ({
  id: 'p1',
  name: 'Cliente',
  description: 'Descrição de teste',
  favorite: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  document: {
    ...emptyDocument(),
    mappings: [
      {
        id: 'm1',
        sourcePath: 'a[*].b',
        targetPath: 'c[*].d',
        sourceType: 'string',
        targetType: 'string',
        transforms: [{ id: 's', transformId: 'uppercase', params: {} }],
        defaultValue: 'x',
        conditions: [{ field: 'a[*].z', operator: 'eq', value: 1 }],
        validationStatus: 'valid',
      },
    ],
    scopes: [
      { id: 'sc', sourcePath: 'a[*]', targetPath: 'c[*]', sort: { field: 'b', direction: 'desc' } },
    ],
  },
  ...over,
});

describe('repositório de projetos', () => {
  let repo: ProjectRepository;
  let name = 0;

  beforeEach(() => {
    repo = new ProjectRepository(`test-${++name}`);
  });
  afterEach(async () => {
    await repo.destroy();
  });

  it('salva e recupera um projeto', async () => {
    const saved = await repo.save(project(), new Date('2024-06-01T00:00:00Z'));
    expect(saved.updatedAt).toBe('2024-06-01T00:00:00.000Z');
    expect(await repo.get('p1')).toEqual(saved);
    expect(await repo.get('nao')).toBeUndefined();
  });

  it('lista do mais recente para o mais antigo', async () => {
    await repo.put(project({ id: 'a', updatedAt: '2024-01-01' }));
    await repo.put(project({ id: 'b', updatedAt: '2024-03-01' }));
    await repo.put(project({ id: 'c', updatedAt: '2024-02-01' }));
    expect((await repo.list()).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('renomeia e rejeita nome vazio', async () => {
    await repo.put(project());
    await repo.rename('p1', '  Novo nome ');
    expect((await repo.get('p1'))?.name).toBe('Novo nome');
    await expect(repo.rename('p1', '   ')).rejects.toThrow();
  });

  it('duplica com novo id e nome único', async () => {
    await repo.put(project({ favorite: true }));
    const copy = await repo.duplicate('p1');
    const copy2 = await repo.duplicate('p1');
    expect(copy.id).not.toBe('p1');
    expect(copy.name).toBe('Cliente (cópia)');
    expect(copy2.name).toBe('Cliente (cópia) 2');
    expect(copy.favorite).toBe(false);
    expect(copy.document.mappings).toEqual(project().document.mappings);
    await expect(repo.duplicate('nao')).rejects.toThrow();
  });

  it('exclui o projeto e suas execuções', async () => {
    await repo.put(project());
    await repo.addExecution({
      projectId: 'p1',
      projectName: 'x',
      executedAt: '2024-01-01',
      durationMs: 1,
      mappedFields: 1,
      transformations: 0,
      errors: 0,
      warnings: 0,
      ok: true,
    });
    await repo.delete('p1');
    expect(await repo.get('p1')).toBeUndefined();
    expect(await repo.listExecutions()).toEqual([]);
  });

  it('favorita', async () => {
    await repo.put(project());
    await repo.setFavorite('p1', true);
    expect((await repo.get('p1'))?.favorite).toBe(true);
  });

  it('busca por nome e descrição sem diferenciar acentos', async () => {
    await repo.put(project({ id: 'a', name: 'Pagamentos', description: 'Integração' }));
    await repo.put(project({ id: 'b', name: 'Clientes', description: '' }));
    expect((await repo.search('integracao')).map((p) => p.id)).toEqual(['a']);
    expect((await repo.search('CLIENT')).map((p) => p.id)).toEqual(['b']);
    expect(await repo.search('')).toHaveLength(2);
  });

  it('limita o histórico de execuções', async () => {
    for (let i = 0; i < 205; i += 40) {
      for (let j = 0; j < 40; j++) {
        await repo.addExecution({
          projectId: 'p',
          projectName: 'x',
          executedAt: new Date(2024, 0, 1, 0, 0, i + j).toISOString(),
          durationMs: 1,
          mappedFields: 1,
          transformations: 0,
          errors: 0,
          warnings: 0,
          ok: true,
        });
      }
    }
    expect(await repo.listExecutions(1000)).toHaveLength(200);
  });
});

describe('formato de arquivo', () => {
  it('preserva tudo em exportação e importação', () => {
    const p = project({ favorite: true, exampleId: 'x' });
    const back = parseProjectFile(serializeProject(p));
    expect(back.document.mappings[0]).toEqual({
      ...p.document.mappings[0],
      validationStatus: 'unknown',
    });
    expect(back.document.scopes).toEqual(p.document.scopes);
    expect(back.document.source).toEqual(p.document.source);
    expect(back).toMatchObject({ id: 'p1', name: 'Cliente', favorite: true, exampleId: 'x' });
  });

  it('inclui versão, metadados, estruturas, mapeamentos e configurações', () => {
    const file = toProjectFile(project());
    expect(file.formatVersion).toBe(FORMAT_VERSION);
    expect(Object.keys(file)).toEqual(
      expect.arrayContaining([
        'format',
        'metadata',
        'structures',
        'mappings',
        'scopes',
        'settings',
      ]),
    );
  });

  const base = () => JSON.parse(serializeProject(project()));
  const change = (fn: (d: Record<string, any>) => void) => {
    const d = base();
    fn(d);
    return JSON.stringify(d);
  };

  it.each<[string, string]>([
    ['JSON malformado', '{'],
    ['raiz não objeto', '[]'],
    ['outro formato', change((d) => (d['format'] = 'x'))],
    ['sem versão', change((d) => delete d['formatVersion'])],
    ['versão futura', change((d) => (d['formatVersion'] = FORMAT_VERSION + 1))],
    ['sem metadados', change((d) => delete d['metadata'])],
    ['nome vazio', change((d) => (d['metadata'].name = ' '))],
    ['sem estruturas', change((d) => delete d['structures'])],
    ['formato de estrutura desconhecido', change((d) => (d['structures'].source.format = 'xml'))],
    ['sem mapeamentos', change((d) => delete d['mappings'])],
    ['caminho inválido', change((d) => (d['mappings'][0].targetPath = 'a..b'))],
    ['caminho perigoso', change((d) => (d['mappings'][0].targetPath = '__proto__.x'))],
    ['tipo desconhecido', change((d) => (d['mappings'][0].sourceType = 'xpto'))],
    ['transformação malformada', change((d) => (d['mappings'][0].transforms = [1]))],
    ['escopo malformado', change((d) => (d['scopes'][0].sort = { direction: 'x' }))],
  ])('rejeita %s', (_, text) => {
    expect(() => parseProjectFile(text)).toThrow(ProjectImportError);
  });

  it('rejeita arquivo acima do limite', () => {
    expect(() => parseProjectFile(serializeProject(project()), 10)).toThrow(/limite/);
  });

  it('gera nome de arquivo seguro', () => {
    expect(projectFileName('Integração / Cliente #1')).toBe('integracao-cliente-1.mapforge.json');
    expect(projectFileName('***')).toBe('projeto.mapforge.json');
  });
});
