import { JsonValue } from '../models/json.model';
import { TransformStep } from '../models/mapping.model';
import { StepTrace } from '../models/execution.model';
import { getTransform, TransformContext } from '../transformations/catalog';
import { isNil, TransformError, Value } from '../transformations/values';

export interface PipelineOutcome {
  value: Value;
  errors: string[];
  trace: StepTrace[];
  runs: number;
}

const NO_CONTEXT: TransformContext = { resolve: () => undefined };

/**
 * Aplica as etapas em sequência. Uma falha é registrada, o valor passa a `null` e as etapas
 * seguintes continuam: nulo atravessa as etapas que não tratam nulos.
 */
export function runPipeline(
  input: Value,
  steps: readonly TransformStep[],
  ctx: TransformContext = NO_CONTEXT,
  withTrace = false,
): PipelineOutcome {
  let value = input;
  const errors: string[] = [];
  const trace: StepTrace[] = [];
  let runs = 0;
  for (const step of steps) {
    if (step.disabled) continue;
    const def = getTransform(step.transformId);
    if (!def) {
      errors.push(`Transformação desconhecida: "${step.transformId}".`);
      continue;
    }
    const before = value;
    let stepError: string | undefined;
    const stepErrors: string[] = [];
    runs++;
    const applyOne = (v: Value): Value => {
      if (isNil(v) && !def.handlesNull) return v;
      try {
        return def.apply(v, step.params, ctx);
      } catch (e) {
        stepErrors.push(e instanceof Error ? e.message : String(e));
        return null;
      }
    };
    value =
      def.kind === 'scalar' && Array.isArray(value)
        ? value.map((el) => (applyOne(el) ?? null) as JsonValue)
        : applyOne(value);
    if (stepErrors.length) {
      stepError = stepErrors[0];
      errors.push(...stepErrors);
    }
    if (withTrace) {
      trace.push({
        stepId: step.id,
        transformId: step.transformId,
        label: def.label,
        input: before,
        output: value,
        error: stepError,
      });
    }
  }
  return { value, errors, trace, runs };
}

export { TransformError };
