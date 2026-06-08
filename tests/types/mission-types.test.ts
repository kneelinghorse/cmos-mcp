import { describe, expect, test } from '@jest/globals';
import {
  genericMissionSchema as reExportedSchema,
  isGenericMission as reExportedIsGenericMission,
} from '../../src/types/mission-types';
import type { GenericMission } from '../../src/types/mission-types';
import {
  genericMissionSchema as sourceSchema,
  isGenericMission,
} from '../../src/schemas/generic-mission';

const makeMission = (mission: GenericMission): GenericMission => mission;

describe('types/mission-types', () => {
  test('re-exports generic mission schema reference', () => {
    expect(reExportedSchema).toBe(sourceSchema);
  });

  test('re-exports isGenericMission guard', () => {
    expect(reExportedIsGenericMission).toBe(isGenericMission);
  });

  test('valid generic mission passes guard', () => {
    const mission = makeMission({
      schemaType: 'Mission',
      schemaVersion: '2.0',
      missionId: 'M-001',
      objective: 'Deliver MVP',
      context: {
        background: 'Greenfield product',
        dependencies: ['core-platform'],
      },
      successCriteria: ['MVP delivered', 'QA sign-off'],
      deliverables: ['MVP release notes'],
      domainFields: {},
    });

    expect(reExportedIsGenericMission(mission)).toBe(true);
  });

  test('invalid mission fails guard', () => {
    const invalidMission = {
      schemaType: 'Mission',
      schemaVersion: '2.0',
      missionId: '',
      objective: '',
      context: { constraints: [] },
      successCriteria: [],
      deliverables: [],
      domainFields: {},
    };

    expect(reExportedIsGenericMission(invalidMission)).toBe(false);
  });
});
