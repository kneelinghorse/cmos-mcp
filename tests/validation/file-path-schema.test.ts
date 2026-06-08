import { describe, expect, test } from '@jest/globals';
import {
  createFilePathSchema,
  RelativeFilePathSchema,
  AbsoluteFilePathSchema,
} from '../../src/validation/schemas/file-path-schema';

describe('createFilePathSchema', () => {
  test('sanitizes relative paths successfully', async () => {
    const sanitized = await RelativeFilePathSchema.parseAsync('src/index.ts');
    expect(typeof sanitized).toBe('string');
    expect(sanitized).toContain('src');
  });

  test('uses default options when none provided', async () => {
    const schema = createFilePathSchema();
    const sanitized = await schema.parseAsync('relative/file.txt');
    expect(sanitized).toContain('relative');
  });

  test('captures validation errors from safeFilePath', async () => {
    await expect(AbsoluteFilePathSchema.parseAsync('relative/path.yaml')).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('Path must be absolute') }),
      ]),
    });
  });
});
