import Dexie, { Table } from 'dexie';
import { ExecutionRecord, MapForgeProject } from '../models/project.model';
import { newId } from '../services/ids';

const MAX_EXECUTIONS = 200;

class MapForgeDb extends Dexie {
  projects!: Table<MapForgeProject, string>;
  executions!: Table<ExecutionRecord, number>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      projects: 'id, name, favorite, updatedAt',
      executions: '++id, projectId, executedAt',
    });
  }
}

/** Persistência local. Não depende de Angular, para ser testável sem TestBed. */
export class ProjectRepository {
  private readonly db: MapForgeDb;

  constructor(name = 'mapforge') {
    this.db = new MapForgeDb(name);
  }

  async list(): Promise<MapForgeProject[]> {
    const all = await this.db.projects.toArray();
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Promise<MapForgeProject | undefined> {
    return this.db.projects.get(id);
  }

  /** Grava o projeto como está. Quem chama decide sobre sobrescrever. */
  async put(project: MapForgeProject): Promise<void> {
    await this.db.projects.put(project);
  }

  async save(project: MapForgeProject, now = new Date()): Promise<MapForgeProject> {
    const saved = { ...project, updatedAt: now.toISOString() };
    await this.db.projects.put(saved);
    return saved;
  }

  async rename(id: string, name: string, now = new Date()): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('O nome do projeto não pode ser vazio.');
    await this.db.projects.update(id, { name: trimmed, updatedAt: now.toISOString() });
  }

  async duplicate(id: string, now = new Date()): Promise<MapForgeProject> {
    const original = await this.db.projects.get(id);
    if (!original) throw new Error('Projeto não encontrado.');
    const copy: MapForgeProject = {
      ...original,
      id: newId('prj'),
      name: await this.uniqueName(`${original.name} (cópia)`),
      favorite: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.db.projects.add(copy);
    return copy;
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.projects, this.db.executions, async () => {
      await this.db.projects.delete(id);
      await this.db.executions.where('projectId').equals(id).delete();
    });
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await this.db.projects.update(id, { favorite });
  }

  /** Busca por nome ou descrição, sem diferenciar maiúsculas e acentos. */
  async search(term: string): Promise<MapForgeProject[]> {
    const normalize = (s: string): string =>
      s
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase();
    const q = normalize(term.trim());
    const all = await this.list();
    return q === '' ? all : all.filter((p) => normalize(`${p.name} ${p.description}`).includes(q));
  }

  async uniqueName(base: string): Promise<string> {
    const names = new Set((await this.db.projects.toArray()).map((p) => p.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  async addExecution(record: ExecutionRecord): Promise<void> {
    await this.db.executions.add(record);
    const count = await this.db.executions.count();
    if (count > MAX_EXECUTIONS) {
      const oldest = await this.db.executions
        .orderBy('executedAt')
        .limit(count - MAX_EXECUTIONS)
        .primaryKeys();
      await this.db.executions.bulkDelete(oldest);
    }
  }

  async listExecutions(limit = 50, projectId?: string): Promise<ExecutionRecord[]> {
    const all = projectId
      ? await this.db.executions.where('projectId').equals(projectId).toArray()
      : await this.db.executions.toArray();
    return all.sort((a, b) => b.executedAt.localeCompare(a.executedAt)).slice(0, limit);
  }

  async clearExecutions(projectId?: string): Promise<void> {
    if (projectId) await this.db.executions.where('projectId').equals(projectId).delete();
    else await this.db.executions.clear();
  }

  async destroy(): Promise<void> {
    await this.db.delete();
  }
}
