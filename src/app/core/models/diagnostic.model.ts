export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'source-missing'
  | 'target-missing'
  | 'type-incompatible'
  | 'unsafe-conversion'
  | 'duplicate-mapping'
  | 'required-unfilled'
  | 'transform-invalid'
  | 'circular-reference'
  | 'path-conflict'
  | 'array-incompatible'
  | 'unexpected-null'
  | 'structure-invalid'
  | 'parser-notice';

export interface Diagnostic {
  id: string;
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Campo afetado. */
  field: string;
  /** Causa do problema. */
  message: string;
  /** Como corrigir. */
  suggestion: string;
  mappingId?: string;
}
