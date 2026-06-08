import { z } from 'zod';
import { MissionIdSchema } from '../common';

export const MissionContextSchema = z
  .object({
    background: z.string().min(1).max(5000).optional(),
    dependencies: z.array(z.string().min(1).max(256)).max(64).optional(),
    constraints: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict()
  .partial();

export const MissionSchema = z.object({
  schemaType: z.literal('Mission'),
  schemaVersion: z.string().regex(/^2\.0$/, 'Only schema version 2.0 is supported'),
  missionId: MissionIdSchema,
  objective: z.string().min(1).max(5000),
  context: MissionContextSchema.optional(),
  successCriteria: z.array(z.string().min(1).max(1024)).min(1),
  deliverables: z.array(z.string().min(1).max(1024)).min(1),
  domainFields: z.record(z.string().min(1), z.unknown()).optional().default({}),
});

export type MissionInput = z.input<typeof MissionSchema>;
export type Mission = z.infer<typeof MissionSchema>;
