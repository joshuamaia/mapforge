import { JsonValue } from './json.model';
import { FieldType } from './schema.model';

export type ConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'in'
  | 'notIn'
  | 'exists'
  | 'notExists'
  | 'empty'
  | 'notEmpty'
  | 'matches';

export interface Condition {
  /**
   * Caminho do campo avaliado. Em mapeamentos usa-se o caminho absoluto e os `[*]` são
   * vinculados à linha corrente (`pedidos[*].status` lê o status do mesmo pedido).
   * Em `ArrayScope.filter`, o caminho é relativo ao item.
   */
  field: string;
  operator: ConditionOperator;
  value?: JsonValue;
}

export type TransformParams = Record<string, JsonValue | undefined>;

export interface TransformStep {
  id: string;
  transformId: string;
  params: TransformParams;
  /** Etapas desabilitadas permanecem na lista, mas não são aplicadas. */
  disabled?: boolean;
}

export type ValidationStatus = 'unknown' | 'valid' | 'warning' | 'error';

export interface Mapping {
  id: string;
  /** Caminho de origem. Vazio significa mapeamento sem origem (por exemplo, constante). */
  sourcePath: string;
  targetPath: string;
  sourceType: FieldType;
  targetType: FieldType;
  transforms: TransformStep[];
  defaultValue?: JsonValue;
  conditions?: Condition[];
  validationStatus: ValidationStatus;
}

/**
 * Regras por linha de um par de arrays. Como filtro, ordenação e distinct são decididos no
 * escopo (e não campo a campo), todos os campos de uma linha continuam vindo do mesmo item.
 */
export interface ArrayScope {
  id: string;
  /** Array de origem até o `[*]`, por exemplo `pedidos[*]`. */
  sourcePath: string;
  /** Array de destino até o `[*]`, por exemplo `orders[*]`. */
  targetPath: string;
  filter?: Condition[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  distinctBy?: string;
}
