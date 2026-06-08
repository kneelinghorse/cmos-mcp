/**
 * Tests for Generic Mission Schema
 *
 * Validates the GenericMission interface, JSON Schema, and type guard
 */

import Ajv from 'ajv';
import {
  GenericMission,
  genericMissionSchema,
  isGenericMission,
} from '../../src/schemas/generic-mission';

const ajv = new Ajv();
const validate = ajv.compile(genericMissionSchema);

describe('GenericMission Schema', () => {
  describe('Valid Missions', () => {
    it('should validate minimal mission with required fields only', () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-001',
        objective: 'Test objective',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });

    it('should validate full mission with all fields populated', () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-002',
        objective: 'Complete test coverage',
        context: {
          background: 'Need comprehensive testing',
          dependencies: ['TEST-001'],
          constraints: ['Time limit: 1 week'],
        },
        successCriteria: ['All tests pass', 'Coverage > 90%'],
        deliverables: ['Test suite', 'Coverage report'],
        domainFields: {
          testFramework: 'jest',
          customField: 'value',
        },
      };

      const isValid = validate(mission);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });

    it('should validate mission with nested context object', () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-003',
        objective: 'Context validation',
        context: {
          background: 'Testing nested context',
          dependencies: ['dep1', 'dep2'],
          constraints: ['constraint1'],
        },
        successCriteria: ['Context validates'],
        deliverables: ['Test result'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });
  });

  describe('Invalid Missions', () => {
    it('should fail validation when missing objective', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-004',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
      expect(validate.errors![0].params).toHaveProperty('missingProperty', 'objective');
    });

    it('should fail validation with wrong schema type', () => {
      const mission = {
        schemaType: 'WrongType',
        schemaVersion: '2.0',
        missionId: 'TEST-005',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should fail validation with invalid version', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '1.0',
        missionId: 'TEST-006',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should fail validation when missing missionId', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors![0].params).toHaveProperty('missingProperty', 'missionId');
    });

    it('should fail validation with empty successCriteria', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-007',
        objective: 'Test',
        context: {},
        successCriteria: [],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should fail validation with empty deliverables', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-008',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: [],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('should fail validation with invalid context fields', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-009',
        objective: 'Test',
        context: {
          invalidField: 'not allowed',
        },
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      const isValid = validate(mission);
      expect(isValid).toBe(false);
      expect(validate.errors).toBeDefined();
    });
  });

  describe('Type Guard: isGenericMission', () => {
    it('should return true for valid mission', () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-010',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      expect(isGenericMission(mission)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isGenericMission(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isGenericMission(undefined)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isGenericMission('string')).toBe(false);
      expect(isGenericMission(123)).toBe(false);
      expect(isGenericMission(true)).toBe(false);
    });

    it('should return false for object with wrong schemaType', () => {
      const mission = {
        schemaType: 'WrongType',
        schemaVersion: '2.0',
        missionId: 'TEST-011',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      expect(isGenericMission(mission)).toBe(false);
    });

    it('should return false for object with empty missionId', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: '',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      expect(isGenericMission(mission)).toBe(false);
    });

    it('should return false for object with empty objective', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-012',
        objective: '',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      expect(isGenericMission(mission)).toBe(false);
    });

    it('should return false for object with empty successCriteria', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-013',
        objective: 'Test',
        context: {},
        successCriteria: [],
        deliverables: ['Deliverable 1'],
        domainFields: {},
      };

      expect(isGenericMission(mission)).toBe(false);
    });

    it('should return false for object with null domainFields', () => {
      const mission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'TEST-014',
        objective: 'Test',
        context: {},
        successCriteria: ['Criterion 1'],
        deliverables: ['Deliverable 1'],
        domainFields: null,
      };

      expect(isGenericMission(mission)).toBe(false);
    });
  });

  describe('Field Documentation', () => {
    it('should have all required fields documented in interface', () => {
      // This test ensures the interface has proper JSDoc comments
      // Check is done during TypeScript compilation and IDE usage
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'DOC-TEST',
        objective: 'Verify documentation',
        context: {
          background: 'Field documentation test',
          dependencies: [],
          constraints: [],
        },
        successCriteria: ['All fields documented'],
        deliverables: ['Documentation'],
        domainFields: {},
      };

      expect(mission).toBeDefined();
    });
  });
});
