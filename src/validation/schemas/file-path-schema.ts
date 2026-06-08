import { z } from 'zod';
import { normalizeValidationError } from '../errors';
import { safeFilePath, SafeFilePathOptions } from '../common';

type SafeFilePathSchema = z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, 'SafeFilePath'>;

export function createFilePathSchema(options: SafeFilePathOptions = {}): SafeFilePathSchema {
  return z
    .string()
    .min(1)
    .transform(async (value, ctx) => {
      try {
        return await safeFilePath(value, options);
      } catch (error) {
        const normalized = normalizeValidationError(error);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: normalized.message,
        });
        return z.NEVER;
      }
    })
    .brand<'SafeFilePath'>();
}

export const AbsoluteFilePathSchema = createFilePathSchema({ allowRelative: false });
export const RelativeFilePathSchema = createFilePathSchema({ allowRelative: true });

export type AbsoluteFilePath = z.infer<typeof AbsoluteFilePathSchema>;
export type RelativeFilePath = z.infer<typeof RelativeFilePathSchema>;
