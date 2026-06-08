import { z } from 'zod';
import { createFilePathSchema } from './file-path-schema';

const PositiveInteger = z
  .number({
    invalid_type_error: 'Value must be a number',
  })
  .int('Value must be an integer')
  .nonnegative('Value must be zero or positive');

export const MissionProtocolConfigSchema = z
  .object({
    baseDir: createFilePathSchema({ allowRelative: true }),
    templateDir: createFilePathSchema({ allowRelative: true }).optional(),
    defaultModel: z.enum(['claude', 'gpt', 'gemini']).default('claude'),
    maxTemplateSize: PositiveInteger.max(10 * 1024 * 1024).optional(), // 10MB hard limit
    maxSchemaSize: PositiveInteger.max(10 * 1024 * 1024).optional(),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type MissionProtocolConfig = z.infer<typeof MissionProtocolConfigSchema>;
