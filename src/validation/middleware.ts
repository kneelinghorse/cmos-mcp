import { z } from 'zod';
import { normalizeValidationError } from './errors';

export type AnyZodSchema = z.ZodTypeAny;

export async function sanitize<TSchema extends AnyZodSchema>(
  input: unknown,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  try {
    return await schema.parseAsync(input);
  } catch (error) {
    throw normalizeValidationError(error);
  }
}

export function validate<TSchema extends AnyZodSchema>(
  schema: TSchema
): <Args extends unknown[], TResult>(
  handler: (input: z.infer<TSchema>, ...rest: Args) => TResult | Promise<TResult>
) => (input: unknown, ...rest: Args) => Promise<TResult> {
  return function <Args extends unknown[], TResult>(
    handler: (input: z.infer<TSchema>, ...rest: Args) => TResult | Promise<TResult>
  ): (input: unknown, ...rest: Args) => Promise<TResult> {
    return async (input: unknown, ...rest: Args): Promise<TResult> => {
      const parsed = await sanitize(input, schema);
      return handler(parsed, ...rest);
    };
  };
}

export async function validateAndSanitize<TSchema extends AnyZodSchema>(
  input: unknown,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  return sanitize(input, schema);
}
