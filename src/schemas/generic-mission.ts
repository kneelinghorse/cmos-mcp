/**
 * Generic Mission Template Schema
 *
 * Universal mission structure using ICEV pattern:
 * - Intent: Objective and desired outcome
 * - Context: Background, dependencies, and constraints
 * - Execution: Implementation details (via domainFields)
 * - Verification: Success criteria and deliverables
 *
 * @version 2.0
 */

/**
 * Core generic mission interface that works across any domain.
 * Domain-specific extensions should be added via the domainFields property.
 */
export interface GenericMission {
  /** Schema type identifier */
  schemaType: 'Mission';

  /** Schema version for compatibility tracking */
  schemaVersion: '2.0';

  /** Unique identifier for this mission */
  missionId: string;

  /** Primary desired outcome - what success looks like */
  objective: string;

  /** Background information and constraints */
  context: {
    /** Why this mission exists and relevant history */
    background?: string;

    /** Other missions, systems, or resources required */
    dependencies?: string[];

    /** Limitations, restrictions, or boundaries */
    constraints?: string[];
  };

  /** Measurable conditions that indicate mission completion */
  successCriteria: string[];

  /** Tangible outputs that will be created */
  deliverables: string[];

  /** Domain-specific fields (populated by domain packs) */
  domainFields: Record<string, unknown>;
}

/**
 * JSON Schema definition for validating GenericMission objects
 */
export const genericMissionSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: [
    'schemaType',
    'schemaVersion',
    'missionId',
    'objective',
    'successCriteria',
    'deliverables',
  ],
  properties: {
    schemaType: {
      type: 'string',
      const: 'Mission',
      description: 'Schema type identifier',
    },
    schemaVersion: {
      type: 'string',
      const: '2.0',
      description: 'Schema version for compatibility',
    },
    missionId: {
      type: 'string',
      minLength: 1,
      description: 'Unique identifier for this mission',
    },
    objective: {
      type: 'string',
      minLength: 1,
      description: 'Primary desired outcome',
    },
    context: {
      type: 'object',
      properties: {
        background: {
          type: 'string',
          description: 'Mission background and history',
        },
        dependencies: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Required missions, systems, or resources',
        },
        constraints: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Limitations or boundaries',
        },
      },
      additionalProperties: false,
    },
    successCriteria: {
      type: 'array',
      items: {
        type: 'string',
      },
      minItems: 1,
      description: 'Measurable completion conditions',
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'string',
      },
      minItems: 1,
      description: 'Tangible outputs to be created',
    },
    domainFields: {
      type: 'object',
      description: 'Domain-specific fields populated by domain packs',
    },
  },
  additionalProperties: false,
} as const;

/**
 * Type guard to check if an object is a valid GenericMission
 */
export function isGenericMission(obj: unknown): obj is GenericMission {
  if (!obj || typeof obj !== 'object') return false;

  const mission = obj as Partial<GenericMission>;

  return (
    mission.schemaType === 'Mission' &&
    mission.schemaVersion === '2.0' &&
    typeof mission.missionId === 'string' &&
    mission.missionId.length > 0 &&
    typeof mission.objective === 'string' &&
    mission.objective.length > 0 &&
    Array.isArray(mission.successCriteria) &&
    mission.successCriteria.length > 0 &&
    Array.isArray(mission.deliverables) &&
    mission.deliverables.length > 0 &&
    typeof mission.domainFields === 'object' &&
    mission.domainFields !== null
  );
}
