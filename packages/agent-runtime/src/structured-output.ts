import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';

export interface StructuredOutputValidationError {
  path: string;
  message: string;
}

export interface StructuredOutputValidation {
  valid: boolean;
  errors: StructuredOutputValidationError[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });

function pathFor(error: ErrorObject): string {
  const parameter = error.params as { additionalProperty?: string; missingProperty?: string };
  const suffix = parameter.additionalProperty ?? parameter.missingProperty;
  const base = `$${error.instancePath}`;
  return suffix ? `${base}/${suffix.replaceAll('~', '~0').replaceAll('/', '~1')}` : base;
}

/**
 * Mirrors `apps/daemon/src/structured-output.ts`'s AJV 2020-12 validation exactly (same library,
 * same options, same error-shaping), kept as a separate small copy rather than a shared import
 * because the daemon and this package are siblings, not parent/child -- neither can import the
 * other's internals, and this ~30-line function is cheaper to duplicate once than to relocate into
 * `packages/shared` (a protocol-types package that should not carry a runtime AJV dependency for
 * every consumer).
 */
export function validateStructuredOutput(schema: unknown, output: unknown): StructuredOutputValidation {
  try {
    const validate = ajv.compile(schema as object | boolean);
    const valid = validate(output);
    const errors: StructuredOutputValidationError[] = valid
      ? []
      : (validate.errors ?? []).slice(0, 1_024).map((error) => ({
          path: pathFor(error).slice(0, 1_024),
          message: (error.message ?? error.keyword).slice(0, 1_024),
        }));
    return { valid: !!valid, errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Schema is invalid';
    return { valid: false, errors: [{ path: '$', message: `Invalid JSON Schema: ${message}`.slice(0, 1_024) }] };
  }
}
