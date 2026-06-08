import { describe, expect, it } from '@jest/globals';
import {
  StructuredPromptingSchema,
  TemplateSpecSchema,
} from '../../src/validation/schemas/template-schema';

describe('TemplateSpecSchema', () => {
  it('accepts structured prompting block with R-C-T-F-C sections', () => {
    const result = TemplateSpecSchema.safeParse({
      structured_prompting: {
        enabled: true,
        role: 'Role guidance',
        context: 'Contextual background',
        task: 'Task definition',
        format: 'Output expectations',
        constraints: 'Non-negotiable constraints',
      },
      additional_field: 'ok',
    });

    expect(result.success).toBe(true);
  });

  it('rejects structured prompting block missing required sections', () => {
    const result = TemplateSpecSchema.safeParse({
      structured_prompting: {
        enabled: true,
        role: '',
        context: 'context',
        task: 'task',
        format: 'format',
        constraints: 'constraints',
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected validation to fail for empty role');
    }
  });

  it('rejects extraneous keys inside structured_prompting', () => {
    const result = StructuredPromptingSchema.safeParse({
      enabled: true,
      role: 'Role guidance',
      context: 'Context',
      task: 'Task',
      format: 'Format',
      constraints: 'Constraints',
      extra: 'not allowed',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected strict structured_prompting schema to reject extra fields');
    }
  });
});
