import { describe, expect, it } from 'vitest';
import { validateStructuredOutput } from '../src/structured-output.js';

describe('validateStructuredOutput', () => {
  it('accepts output that matches the schema', () => {
    const result = validateStructuredOutput(
      { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
      { answer: 42 },
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects output that violates the schema, with a bounded error list', () => {
    const result = validateStructuredOutput(
      { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
      { answer: 'not a number' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path).toBe('$/answer');
  });

  it('reports an invalid schema itself as a validation failure rather than throwing', () => {
    const result = validateStructuredOutput({ type: 'not-a-real-type' }, { answer: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain('Invalid JSON Schema');
  });
});
