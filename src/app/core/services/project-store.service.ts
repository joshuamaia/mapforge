import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ExampleDefinition } from '../examples/examples';
import { executeMappings } from '../mapping-engine/engine';
import { isValidPath, parsePathOrEmpty, wildcardPrefixes } from '../mapping-engine/path';
import { ExecutionResult } from '../models/execution.model';
import { JsonValue } from '../models/json.model';
import { ArrayScope, Mapping, TransformStep } from '../models/mapping.model';
import {
  ExecutionRecord,
  FieldOverride,
  MapForgeProject,
  ProjectDocument,
  StructureDefinition,
  emptyDocument,
} from '../models/project.model';
import { StructureFormat } from '../models/schema.model';
import { parseJsonSafe } from '../parsers/json-parser';
import { indexFields, parseStructure, sampleFromSchema } from '../parsers/structure';
import { MappingSuggestion, suggestMappings } from '../smart-mapping/smart-mapping';
import {
  parseProjectFile,
  ProjectImportError,
  projectFileName,
  serializeProject,
} from '../storage/project-file';
import { ProjectRepository } from '../storage/project-repository';
import { defaultParams, getTransform } from '../transformations/catalog';
import { runDiagnostics, statusFromDiagnostics } from '../validators/diagnostics';
import { EngineRunner } from './engine-runner.service';
import { newId } from './ids';
import { SettingsService } from './settings.service';
import { ConfirmService, ToastService } from './ui.services';

const LAST_PROJECT_KEY = 'mapforge.lastProject';
const HISTORY_LIMIT = 100;
/** Edições de texto seguidas no mesmo campo viram uma única entrada de undo. */
const COALESCE_MS = 800;

export type Side = 'source' | 'target';

export function downloadText(fileName: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lê um arquivo local respeitando o limite de tamanho configurado. */
export async function readTextFile(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(
      `O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB e excede o limite de ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }
  return file.text();
}

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly runner = inject(EngineRunner);
  readonly repository = new ProjectRepository();

  // ------------------------------------------------------------------ estado
  readonly project = signal<MapForgeProject>(this.blankProject());
  readonly savedRevision = signal(0);
  readonly revision = signal(0);
  readonly isPersisted = signal(false);
  readonly dirty = computed(() => this.revision() !== this.savedRevision());
  readonly saving = signal(false);

  private readonly undoStack = signal<ProjectDocument[]>([]);
  private readonly redoStack = signal<ProjectDocument[]>([]);
  private lastCoalesce = { key: '', at: 0 };
  readonly canUndo = computed(() => this.undoStack().length > 0);
  readonly canRedo = computed(() => this.redoStack().length > 0);

  readonly selectedMappingId = signal<string | null>(null);
  readonly highlightedPath = signal<{ side: Side; path: string } | null>(null);
  readonly libraryVersion = signal(0);

  // ------------------------------------------------------------------ derivados
  readonly document = computed(() => this.project().document);
  readonly sourceParsed = computed(() =>
    parseStructure(this.document().source, this.settings.limits()),
  );
  readonly targetParsed = computed(() =>
    parseStructure(this.document().target, this.settings.limits()),
  );
  readonly sourceFields = computed(() => indexFields(this.sourceParsed().root));
  readonly targetFields = computed(() => indexFields(this.targetParsed().root));
  readonly sample = computed(() =>
    parseJsonSafe(this.document().sampleData, this.settings.limits()),
  );

  readonly diagnostics = computed(() => {
    const doc = this.document();
    const sample = this.sample();
    return runDiagnostics({
      mappings: doc.mappings,
      scopes: doc.scopes,
      source: this.sourceParsed(),
      target: this.targetParsed(),
      sampleData: sample.ok ? sample.value : undefined,
      sampleError: sample.ok ? undefined : sample.message,
    });
  });

  readonly mappings = computed<Mapping[]>(() => {
    const diagnostics = this.diagnostics();
    return this.document().mappings.map((m) => ({
      ...m,
      validationStatus: statusFromDiagnostics(m.id, diagnostics),
    }));
  });

  readonly selectedMapping = computed(
    () => this.mappings().find((m) => m.id === this.selectedMappingId()) ?? null,
  );
  readonly mappedSources = computed(
    () => new Set(this.document().mappings.map((m) => m.sourcePath)),
  );
  readonly mappedTargets = computed(
    () => new Set(this.document().mappings.map((m) => m.targetPath)),
  );
  readonly errorCount = computed(
    () => this.diagnostics().filter((d) => d.severity === 'error').length,
  );

  readonly suggestions = signal<MappingSuggestion[]>([]);
  readonly rejectedSuggestions = signal<Set<string>>(new Set());

  // ------------------------------------------------------------------ preview
  readonly preview = signal<ExecutionResult | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly running = signal(false);
  readonly autoPreview = signal(true);
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private runSeq = 0;

  constructor() {
    effect(() => {
      this.document();
      const delay = this.settings.settings().previewDebounceMs;
      untracked(() => {
        if (!this.autoPreview()) return;
        if (this.previewTimer) clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => void this.execute(), delay);
      });
    });
    void this.restoreLast();
  }

  private blankProject(name = 'Novo mapeamento'): MapForgeProject {
    const now = new Date().toISOString();
    const document = emptyDocument();
    return {
      id: newId('prj'),
      name,
      description: '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      document: {
        ...document,
        codegen: {
          ...document.codegen,
          javaPackage: this.settings.settings().defaultJavaPackage,
          comments: this.settings.settings().defaultComments,
        },
      },
    };
  }

  // ------------------------------------------------------------------ documento e histórico

  /** Toda mudança do documento passa por aqui para entrar no undo/redo. */
  updateDocument(change: (doc: ProjectDocument) => ProjectDocument, coalesceKey?: string): void {
    const current = this.project();
    const next = change(current.document);
    if (next === current.document) return;
    const now = Date.now();
    const merge =
      coalesceKey !== undefined &&
      coalesceKey === this.lastCoalesce.key &&
      now - this.lastCoalesce.at < COALESCE_MS;
    if (!merge) this.undoStack.update((s) => [...s.slice(-(HISTORY_LIMIT - 1)), current.document]);
    this.lastCoalesce = { key: coalesceKey ?? '', at: now };
    this.redoStack.set([]);
    this.project.set({ ...current, document: next });
    this.revision.update((r) => r + 1);
  }

  undo(): void {
    const stack = this.undoStack();
    if (stack.length === 0) return;
    const current = this.project();
    this.redoStack.update((s) => [...s, current.document]);
    this.undoStack.set(stack.slice(0, -1));
    this.project.set({ ...current, document: stack[stack.length - 1] });
    this.revision.update((r) => r + 1);
    this.lastCoalesce = { key: '', at: 0 };
    this.keepSelectionValid();
  }

  redo(): void {
    const stack = this.redoStack();
    if (stack.length === 0) return;
    const current = this.project();
    this.undoStack.update((s) => [...s, current.document]);
    this.redoStack.set(stack.slice(0, -1));
    this.project.set({ ...current, document: stack[stack.length - 1] });
    this.revision.update((r) => r + 1);
    this.lastCoalesce = { key: '', at: 0 };
    this.keepSelectionValid();
  }

  private keepSelectionValid(): void {
    const id = this.selectedMappingId();
    if (id && !this.document().mappings.some((m) => m.id === id)) this.selectedMappingId.set(null);
  }

  private resetHistory(): void {
    this.undoStack.set([]);
    this.redoStack.set([]);
    this.lastCoalesce = { key: '', at: 0 };
    this.selectedMappingId.set(null);
    this.suggestions.set([]);
    this.rejectedSuggestions.set(new Set());
  }

  // ------------------------------------------------------------------ estruturas

  setStructureText(side: Side, text: string): void {
    this.updateDocument((doc) => {
      if (doc[side].text === text) return doc;
      const next = { ...doc, [side]: { ...doc[side], text } };
      // Enquanto os dados de entrada acompanham o JSON de origem, seguem juntos.
      if (side === 'source' && doc.source.format === 'json' && doc.sampleData === doc.source.text) {
        next.sampleData = text;
      }
      return next;
    }, `text:${side}`);
  }

  setStructureFormat(side: Side, format: StructureFormat): void {
    this.updateDocument((doc) => ({ ...doc, [side]: { ...doc[side], format } }));
  }

  setRootName(side: Side, rootName: string): void {
    this.updateDocument((doc) => ({ ...doc, [side]: { ...doc[side], rootName } }), `root:${side}`);
  }

  setSampleData(text: string): void {
    this.updateDocument(
      (doc) => (doc.sampleData === text ? doc : { ...doc, sampleData: text }),
      'sample',
    );
  }

  /** Substitui a estrutura por um texto importado, adotando o nome da raiz encontrada. */
  importStructure(side: Side, format: StructureFormat, text: string): void {
    this.updateDocument((doc) => {
      const definition: StructureDefinition = { ...doc[side], format, text, overrides: {} };
      const parsed = parseStructure({ ...definition, rootName: '' }, this.settings.limits());
      const named = {
        ...definition,
        rootName: format === 'json' ? doc[side].rootName : parsed.rootName,
      };
      const next = { ...doc, [side]: named };
      if (side === 'source') {
        next.sampleData =
          format === 'json' ? text : JSON.stringify(sampleFromSchema(parsed.root), null, 2);
      }
      return next;
    });
  }

  generateSampleFromSchema(): void {
    const root = this.sourceParsed().root;
    if (!root) {
      this.toasts.warning('Corrija a estrutura de origem antes de gerar os dados de exemplo.');
      return;
    }
    this.setSampleData(JSON.stringify(sampleFromSchema(root), null, 2));
  }

  setOverride(side: Side, path: string, patch: FieldOverride): void {
    this.updateDocument((doc) => {
      const overrides = {
        ...doc[side].overrides,
        [path]: { ...doc[side].overrides[path], ...patch },
      };
      return { ...doc, [side]: { ...doc[side], overrides } };
    });
  }

  // ------------------------------------------------------------------ mapeamentos

  addMapping(sourcePath: string, targetPath: string): Mapping | null {
    if (!isValidPath(targetPath) || (sourcePath !== '' && !isValidPath(sourcePath))) {
      this.toasts.error('Caminho inválido.');
      return null;
    }
    const exists = this.document().mappings.find(
      (m) => m.sourcePath === sourcePath && m.targetPath === targetPath,
    );
    if (exists) {
      this.selectedMappingId.set(exists.id);
      this.toasts.info('Essa conexão já existe.');
      return exists;
    }
    const mapping: Mapping = {
      id: newId('map'),
      sourcePath,
      targetPath,
      sourceType: this.sourceFields().get(sourcePath)?.type ?? 'any',
      targetType: this.targetFields().get(targetPath)?.type ?? 'any',
      transforms: [],
      validationStatus: 'unknown',
    };
    this.updateDocument((doc) => ({ ...doc, mappings: [...doc.mappings, mapping] }));
    this.selectedMappingId.set(mapping.id);
    return mapping;
  }

  removeMapping(id: string): void {
    this.updateDocument((doc) => ({ ...doc, mappings: doc.mappings.filter((m) => m.id !== id) }));
    if (this.selectedMappingId() === id) this.selectedMappingId.set(null);
  }

  updateMapping(id: string, patch: Partial<Mapping>, coalesceKey?: string): void {
    this.updateDocument(
      (doc) => ({
        ...doc,
        mappings: doc.mappings.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }),
      coalesceKey,
    );
  }

  clearMappings(): void {
    this.updateDocument((doc) => ({ ...doc, mappings: [], scopes: [] }));
    this.selectedMappingId.set(null);
  }

  addStep(mappingId: string, transformId: string): void {
    const def = getTransform(transformId);
    if (!def) return;
    const step: TransformStep = { id: newId('step'), transformId, params: defaultParams(def) };
    this.changeSteps(mappingId, (steps) => [...steps, step]);
  }

  updateStep(mappingId: string, stepId: string, patch: Partial<TransformStep>): void {
    this.changeSteps(
      mappingId,
      (steps) => steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
      `step:${stepId}`,
    );
  }

  removeStep(mappingId: string, stepId: string): void {
    this.changeSteps(mappingId, (steps) => steps.filter((s) => s.id !== stepId));
  }

  moveStep(mappingId: string, from: number, to: number): void {
    this.changeSteps(mappingId, (steps) => {
      const copy = [...steps];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    });
  }

  private changeSteps(
    id: string,
    change: (steps: TransformStep[]) => TransformStep[],
    key?: string,
  ): void {
    const mapping = this.document().mappings.find((m) => m.id === id);
    if (mapping) this.updateMapping(id, { transforms: change(mapping.transforms) }, key);
  }

  // ------------------------------------------------------------------ escopos de array

  /** Pares de arrays presentes nos mapeamentos: são os que aceitam um escopo. */
  readonly arrayPairs = computed(() => {
    const pairs = new Map<string, { sourcePath: string; targetPath: string }>();
    for (const m of this.document().mappings) {
      const sp = safePrefixes(m.sourcePath);
      const tp = safePrefixes(m.targetPath);
      for (let i = 0; i < Math.min(sp.length, tp.length); i++) {
        pairs.set(`${sp[i]}=>${tp[i]}`, { sourcePath: sp[i], targetPath: tp[i] });
      }
    }
    return [...pairs.values()];
  });

  upsertScope(sourcePath: string, targetPath: string, patch: Partial<ArrayScope>): void {
    this.updateDocument((doc) => {
      const existing = doc.scopes.find(
        (s) => s.sourcePath === sourcePath && s.targetPath === targetPath,
      );
      const scopes = existing
        ? doc.scopes.map((s) => (s === existing ? { ...s, ...patch } : s))
        : [...doc.scopes, { id: newId('scope'), sourcePath, targetPath, ...patch }];
      return { ...doc, scopes };
    }, `scope:${sourcePath}:${targetPath}`);
  }

  removeScope(id: string): void {
    this.updateDocument((doc) => ({ ...doc, scopes: doc.scopes.filter((s) => s.id !== id) }));
  }

  // ------------------------------------------------------------------ Smart Mapping

  runSmartMapping(): void {
    const rejected = this.rejectedSuggestions();
    const list = suggestMappings(this.sourceParsed().root, this.targetParsed().root, {
      synonyms: this.settings.synonyms(),
      existing: this.document().mappings,
    }).filter((s) => !rejected.has(s.id));
    this.suggestions.set(list);
    if (list.length === 0) this.toasts.info('Nenhuma nova sugestão encontrada.');
  }

  acceptSuggestion(id: string): void {
    const s = this.suggestions().find((x) => x.id === id);
    if (!s) return;
    this.addMapping(s.sourcePath, s.targetPath);
    this.suggestions.update((list) =>
      list.filter(
        (x) => x.id !== id && x.sourcePath !== s.sourcePath && x.targetPath !== s.targetPath,
      ),
    );
  }

  rejectSuggestion(id: string): void {
    this.rejectedSuggestions.update((set) => new Set(set).add(id));
    this.suggestions.update((list) => list.filter((x) => x.id !== id));
  }

  /** Aceita só as de confiança alta e sem ambiguidade. O resto segue para decisão individual. */
  acceptHighConfidence(): number {
    const safe = this.suggestions().filter((s) => s.level === 'high' && !s.ambiguous);
    if (safe.length === 0) return 0;
    const ids = new Set(safe.map((s) => s.id));
    const created: Mapping[] = safe.map((s) => ({
      id: newId('map'),
      sourcePath: s.sourcePath,
      targetPath: s.targetPath,
      sourceType: s.sourceType,
      targetType: s.targetType,
      transforms: [],
      validationStatus: 'unknown',
    }));
    this.updateDocument((doc) => ({ ...doc, mappings: [...doc.mappings, ...created] }));
    const usedS = new Set(safe.map((s) => s.sourcePath));
    const usedT = new Set(safe.map((s) => s.targetPath));
    this.suggestions.update((list) =>
      list.filter((x) => !ids.has(x.id) && !usedS.has(x.sourcePath) && !usedT.has(x.targetPath)),
    );
    return safe.length;
  }

  // ------------------------------------------------------------------ execução

  /** Executa o documento atual; só os dados e os mapeamentos vão para o worker. */
  async execute(): Promise<ExecutionResult | null> {
    const doc = this.document();
    const sample = this.sample();
    const seq = ++this.runSeq;
    if (!sample.ok) {
      this.previewError.set(sample.message);
      this.preview.set(null);
      return null;
    }
    this.running.set(true);
    try {
      const result = await this.runner.run({
        source: sample.value,
        mappings: doc.mappings,
        scopes: doc.scopes,
      });
      if (seq === this.runSeq) {
        this.preview.set(result);
        this.previewError.set(null);
      }
      return result;
    } catch (e) {
      if (seq === this.runSeq) {
        this.previewError.set(e instanceof Error ? e.message : String(e));
        this.preview.set(null);
      }
      return null;
    } finally {
      if (seq === this.runSeq) this.running.set(false);
    }
  }

  /** Execução pedida pelo usuário: valida, executa e registra no histórico local. */
  async runMapping(): Promise<ExecutionResult | null> {
    const result = await this.execute();
    if (!result) {
      this.toasts.error(this.previewError() ?? 'A execução falhou.');
      return null;
    }
    const record: ExecutionRecord = {
      projectId: this.project().id,
      projectName: this.project().name,
      executedAt: new Date().toISOString(),
      durationMs: result.stats.durationMs,
      mappedFields: result.stats.mappedFields,
      transformations: result.stats.transformations,
      errors: result.issues.filter((i) => i.severity === 'error').length,
      warnings: result.issues.filter((i) => i.severity === 'warning').length,
      ok: result.ok,
    };
    await this.repository.addExecution(record).catch(() => undefined);
    this.libraryVersion.update((v) => v + 1);
    return result;
  }

  // ------------------------------------------------------------------ ciclo de vida do projeto

  /** Evita perder alterações: devolve falso se o usuário desistir. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty()) return true;
    const answer = await this.confirm.ask({
      title: 'Alterações não salvas',
      message: `"${this.project().name}" tem alterações que ainda não foram salvas.`,
      confirmLabel: 'Salvar',
      alternativeLabel: 'Descartar',
      cancelLabel: 'Cancelar',
    });
    if (answer === 'cancel') return false;
    if (answer === 'confirm') await this.save();
    return true;
  }

  private replaceProject(project: MapForgeProject, persisted: boolean): void {
    this.project.set(project);
    this.resetHistory();
    this.revision.update((r) => r + 1);
    this.savedRevision.set(this.revision());
    this.isPersisted.set(persisted);
    this.preview.set(null);
    this.previewError.set(null);
    this.rememberLast(persisted ? project.id : null);
    if (!this.autoPreview()) void this.execute();
  }

  async newProject(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    this.replaceProject(
      this.blankProject(await this.repository.uniqueName('Novo mapeamento')),
      false,
    );
    return true;
  }

  async openProject(id: string): Promise<boolean> {
    if (id !== this.project().id && !(await this.confirmDiscard())) return false;
    const project = await this.repository.get(id);
    if (!project) {
      this.toasts.error('Projeto não encontrado.');
      return false;
    }
    this.replaceProject(project, true);
    return true;
  }

  /** Abre um exemplo como projeto novo. Uma cópia é usada, então a galeria não muda. */
  async openExample(example: ExampleDefinition): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    const now = new Date().toISOString();
    const document = JSON.parse(JSON.stringify(example.document)) as ProjectDocument;
    this.replaceProject(
      {
        id: newId('prj'),
        name: await this.repository.uniqueName(`Exemplo: ${example.title}`),
        description: example.description,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        exampleId: example.id,
        document,
      },
      false,
    );
    return true;
  }

  rename(name: string): void {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === this.project().name) return;
    this.project.update((p) => ({ ...p, name: trimmed }));
    this.revision.update((r) => r + 1);
  }

  setDescription(description: string): void {
    if (description === this.project().description) return;
    this.project.update((p) => ({ ...p, description }));
    this.revision.update((r) => r + 1);
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      const document: ProjectDocument = {
        ...this.document(),
        mappings: this.mappings(),
      };
      const saved = await this.repository.save({ ...this.project(), document });
      this.project.set(saved);
      this.savedRevision.set(this.revision());
      this.isPersisted.set(true);
      this.rememberLast(saved.id);
      this.libraryVersion.update((v) => v + 1);
      this.toasts.success(`"${saved.name}" salvo.`);
    } catch (e) {
      this.toasts.error(`Não foi possível salvar: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.saving.set(false);
    }
  }

  exportCurrent(): void {
    const project = this.project();
    downloadText(projectFileName(project.name), serializeProject(project));
    this.toasts.success('Projeto exportado.');
  }

  /** Importa um arquivo validado. Nunca sobrescreve um projeto sem confirmação. */
  async importProjectFile(file: File): Promise<MapForgeProject | null> {
    let project: MapForgeProject;
    try {
      project = parseProjectFile(await readTextFile(file, this.settings.limits().maxBytes * 4));
    } catch (e) {
      this.toasts.error(
        e instanceof ProjectImportError || e instanceof Error ? e.message : 'Arquivo inválido.',
      );
      return null;
    }
    const existing = await this.repository.get(project.id);
    if (existing) {
      const answer = await this.confirm.ask({
        title: 'Projeto já existe',
        message: `Já existe o projeto "${existing.name}" com o mesmo identificador. O que deseja fazer?`,
        confirmLabel: 'Sobrescrever',
        alternativeLabel: 'Importar como cópia',
        cancelLabel: 'Cancelar',
        danger: true,
      });
      if (answer === 'cancel') return null;
      if (answer === 'alternative') {
        const now = new Date().toISOString();
        project = {
          ...project,
          id: newId('prj'),
          name: await this.repository.uniqueName(`${project.name} (importado)`),
          createdAt: now,
          updatedAt: now,
        };
      }
    }
    await this.repository.put(project);
    this.libraryVersion.update((v) => v + 1);
    this.toasts.success(`Projeto "${project.name}" importado.`);
    if (project.id === this.project().id) this.replaceProject(project, true);
    return project;
  }

  /** Reflete mudanças feitas na lista de projetos sobre o projeto aberto. */
  syncFromLibrary(project: MapForgeProject): void {
    if (project.id === this.project().id) {
      this.project.update((p) => ({ ...p, name: project.name, favorite: project.favorite }));
    }
    this.libraryVersion.update((v) => v + 1);
  }

  handleDeleted(id: string): void {
    if (id === this.project().id) this.replaceProject(this.blankProject(), false);
    this.libraryVersion.update((v) => v + 1);
  }

  private rememberLast(id: string | null): void {
    try {
      if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
      else localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      // Sem armazenamento: apenas não restaura o último projeto.
    }
  }

  private async restoreLast(): Promise<void> {
    let id: string | null = null;
    try {
      id = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      return;
    }
    if (!id) return;
    const project = await this.repository.get(id).catch(() => undefined);
    if (project && !this.dirty()) this.replaceProject(project, true);
  }

  /** Execução síncrona para prévias pequenas (por exemplo, no catálogo). */
  quickRun(source: JsonValue): ExecutionResult {
    return executeMappings({
      source,
      mappings: this.document().mappings,
      scopes: this.document().scopes,
    });
  }
}

function safePrefixes(path: string): string[] {
  try {
    parsePathOrEmpty(path);
    return wildcardPrefixes(path);
  } catch {
    return [];
  }
}
