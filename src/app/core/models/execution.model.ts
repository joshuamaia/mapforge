import { JsonValue } from './json.model';

export interface EngineIssue {
  severity: 'error' | 'warning' | 'info';
  mappingId?: string;
  field?: string;
  message: string;
  kind: 'validation' | 'conversion' | 'missing' | 'conflict' | 'runtime';
}

export interface StepTrace {
  stepId: string;
  transformId: string;
  label: string;
  input: JsonValue | undefined;
  output: JsonValue | undefined;
  error?: string;
}

export interface IgnoredField {
  path: string;
  mappingId?: string;
  reason: string;
}

export interface ExecutionStats {
  /** Campos de destino que receberam pelo menos um valor. */
  mappedFields: number;
  /** Etapas de transformação declaradas e ativas. */
  transformations: number;
  /** Execuções de etapas (uma etapa roda uma vez por linha). */
  transformationRuns: number;
  conversionErrors: number;
  durationMs: number;
}

export interface ExecutionResult {
  ok: boolean;
  output: JsonValue;
  issues: EngineIssue[];
  ignored: IgnoredField[];
  stats: ExecutionStats;
  /** Etapas da primeira linha processada de cada mapeamento. */
  traces: Record<string, StepTrace[]>;
}
