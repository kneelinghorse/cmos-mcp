// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preserve arbitrary mission JSON and actionable validation refusals across the Zod upgrade.
// ABOUTME: Exercise every migrated record schema and both handlers that inspect validation issues.

import { cmosMissionAddSchema } from '../../../src/tools/cmos/cmos-mission-add';
import { cmosMissionUpdateSchema } from '../../../src/tools/cmos/cmos-mission-update';
import { cmosMissionSchema } from '../../../src/tools/cmos/cmos-mission';
import { cmosProjectInit } from '../../../src/tools/cmos/cmos-project-init';
import { cmosSessionStart } from '../../../src/tools/cmos/cmos-session-start';

const records = [
  ...['context', 'domainFields'].map((field) => ({
    name: `mission add ${field}`,
    parse: (value: unknown) =>
      cmosMissionAddSchema.safeParse({
        missionId: 'schema-mission',
        name: 'Preserve caller metadata',
        sprintId: 'schema-sprint',
        [field]: value,
      }),
  })),
  ...['domainFields', 'metadata'].map((field) => ({
    name: `mission update ${field}`,
    parse: (value: unknown) =>
      cmosMissionUpdateSchema.safeParse({
        missionId: 'schema-mission',
        fields: { [field]: value },
      }),
  })),
  ...['context', 'domainFields'].map((field) => ({
    name: `mission router ${field}`,
    parse: (value: unknown) => cmosMissionSchema.safeParse({ action: 'add', [field]: value }),
  })),
  ...['context', 'domainFields', 'metadata'].map((field) => ({
    name: `mission router fields.${field}`,
    parse: (value: unknown) =>
      cmosMissionSchema.safeParse({ action: 'update', fields: { [field]: value } }),
  })),
];

describe('SDK v2 validation compatibility', () => {
  it.each(records)('$name retains heterogeneous caller JSON', ({ parse }) => {
    const metadata = {
      text: 'reason',
      count: 2,
      enabled: true,
      empty: null,
      nested: { values: [1, 'x'] },
    };
    const result = parse(metadata);
    expect(result.success).toBe(true);
    if (result.success) expect(JSON.stringify(result.data)).toContain(JSON.stringify(metadata));
  });

  it.each(records)(
    '$name refuses arrays instead of treating them as metadata objects',
    ({ parse }) => {
      expect(parse(['not a key-value object']).success).toBe(false);
    }
  );

  it('init reports the invalid field before it attempts any project creation', async () => {
    const result = await cmosProjectInit({
      projectRoot: '/schema-validation-must-not-create-this-project',
      projectName: 42 as unknown as string,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER', field: 'projectName', providedValue: 42 },
    });
  });

  it('session start reports a bad enum instead of throwing while reading the validation error', async () => {
    const result = await cmosSessionStart({
      type: 'invalid-session-type' as 'review',
      title: 'A title valid enough to reach schema validation',
      projectRoot: '/schema-validation-must-not-open-this-project',
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER', field: 'type', providedValue: 'invalid-session-type' },
    });
  });
});
