import { z } from 'zod';
import { sanitize, validate, validateAndSanitize } from '../../src/validation/middleware';
import { ValidationError } from '../../src/validation/errors';

describe('validation middleware', () => {
  const schema = z.object({ name: z.string() });

  it('sanitizes valid input', async () => {
    const result = await sanitize({ name: 'ok' }, schema);
    expect(result).toEqual({ name: 'ok' });
  });

  it('throws ValidationError for invalid input', async () => {
    await expect(sanitize({}, schema)).rejects.toBeInstanceOf(ValidationError);
  });

  it('validate decorator parses input before handler', async () => {
    const handler = jest.fn(async (input: { name: string }) => `Hello ${input.name}`);
    const validated = validate(schema)(handler);

    const result = await validated({ name: 'world' });

    expect(handler).toHaveBeenCalledWith({ name: 'world' });
    expect(result).toBe('Hello world');
  });

  it('validateAndSanitize delegates to sanitize', async () => {
    const value = await validateAndSanitize({ name: 'delegated' }, schema);
    expect(value.name).toBe('delegated');
  });
});
