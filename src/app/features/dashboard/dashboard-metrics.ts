import { ExecutionRecord, MapForgeProject } from '../../core/models/project.model';
import { getTransform } from '../../core/transformations/catalog';
import { diagnoseDocument } from '../../core/validators/diagnostics';

export interface ProjectWithErrors {
  project: MapForgeProject;
  errors: number;
}

export interface DashboardMetrics {
  totalProjects: number;
  totalMappings: number;
  totalTransformations: number;
  topTransformations: { id: string; label: string; count: number }[];
  recentProjects: MapForgeProject[];
  recentExecutions: ExecutionRecord[];
  withErrors: ProjectWithErrors[];
  favorites: MapForgeProject[];
}

/** Indicadores calculados só com o que está salvo localmente. */
export function computeMetrics(
  projects: readonly MapForgeProject[],
  executions: readonly ExecutionRecord[],
): DashboardMetrics {
  const counts = new Map<string, number>();
  let totalMappings = 0;
  let totalTransformations = 0;
  const withErrors: ProjectWithErrors[] = [];
  for (const project of projects) {
    totalMappings += project.document.mappings.length;
    for (const m of project.document.mappings) {
      for (const t of m.transforms) {
        if (t.disabled) continue;
        totalTransformations++;
        counts.set(t.transformId, (counts.get(t.transformId) ?? 0) + 1);
      }
    }
    const errors = diagnoseDocument(project.document).filter((d) => d.severity === 'error').length;
    if (errors > 0) withErrors.push({ project, errors });
  }
  const byDate = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    totalProjects: projects.length,
    totalMappings,
    totalTransformations,
    topTransformations: [...counts.entries()]
      .map(([id, count]) => ({ id, count, label: getTransform(id)?.label ?? id }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 8),
    recentProjects: byDate.slice(0, 5),
    recentExecutions: executions.slice(0, 6),
    withErrors: withErrors.sort((a, b) => b.errors - a.errors),
    favorites: byDate.filter((p) => p.favorite),
  };
}
