import { z } from 'zod';

const SemVerSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Version must follow semantic versioning (X.Y.Z)');

const ChecksumSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/i, 'Checksum must be a SHA-256 digest');

export const TemplateSignatureSchema = z.object({
  keyId: z.string().min(1).max(128),
  algorithm: z.enum(['PGP-SHA256', 'RS256', 'ES256']),
  value: z.string().min(1),
});

export const TemplateMetadataSchema = z.object({
  name: z.string().min(1).max(128),
  version: SemVerSchema,
  author: z.string().min(1).max(128),
  signature: TemplateSignatureSchema,
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const TemplateDependencySchema = z.object({
  name: z.string().min(1).max(128),
  sourceUrl: z.string().url(),
  version: SemVerSchema,
  checksum: ChecksumSchema,
});

export const StructuredPromptingSchema = z
  .object({
    enabled: z.boolean().default(true),
    role: z.string().min(1, 'structured_prompting.role must be non-empty'),
    context: z.string().min(1, 'structured_prompting.context must be non-empty'),
    task: z.string().min(1, 'structured_prompting.task must be non-empty'),
    format: z.string().min(1, 'structured_prompting.format must be non-empty'),
    constraints: z.string().min(1, 'structured_prompting.constraints must be non-empty'),
  })
  .strict();

export const TemplateSpecSchema = z
  .object({
    structured_prompting: StructuredPromptingSchema.optional(),
  })
  .catchall(z.unknown());

export const MissionTemplateSchema = z.object({
  apiVersion: z
    .string({
      required_error: 'Template must have apiVersion: "mission-template.v1"',
    })
    .refine((value) => value === 'mission-template.v1', {
      message: 'Template must have apiVersion: "mission-template.v1"',
    }),
  kind: z
    .string({
      required_error: 'Template must have kind: "MissionTemplate"',
    })
    .refine((value) => value === 'MissionTemplate', {
      message: 'Template must have kind: "MissionTemplate"',
    }),
  metadata: TemplateMetadataSchema,
  spec: TemplateSpecSchema,
  dependencies: z.array(TemplateDependencySchema).max(64).optional(),
});

export type MissionTemplate = z.infer<typeof MissionTemplateSchema>;
