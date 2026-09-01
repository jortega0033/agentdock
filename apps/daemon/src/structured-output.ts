import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import type { StructuredWorkflowResultV2 } from '@agent-dock/shared';

interface ValidationError {
  path: string;
  message: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });

function pathFor(error: ErrorObject): string {
  const parameter = error.params as { additionalProperty?: string; missingProperty?: string };
  const suffix = parameter.additionalProperty ?? parameter.missingProperty;
  const base = `$${error.instancePath}`;
  return suffix ? `${base}/${suffix.replaceAll('~', '~0').replaceAll('/', '~1')}` : base;
}

export function validateStructuredOutput(
  schema: unknown,
  output: unknown,
): StructuredWorkflowResultV2 {
  try {
    const validate = ajv.compile(schema as object | boolean);
    const valid = validate(output);
    const errors: ValidationError[] = valid
      ? []
      : (validate.errors ?? []).slice(0, 1_024).map((error) => ({
          path: pathFor(error).slice(0, 1_024),
          message: (error.message ?? error.keyword).slice(0, 1_024),
        }));
    return { valid: !!valid, normalizedOutput: structuredClone(output), errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Schema is invalid';
    return {
      valid: false,
      normalizedOutput: structuredClone(output),
      errors: [{ path: '$', message: `Invalid JSON Schema: ${message}`.slice(0, 1_024) }],
    };
  }
}
