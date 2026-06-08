import { describe, expect, test } from '@jest/globals';
import { MissionProtocolError } from '../../src/errors/mission-error';

const baseOptions = {
  message: 'Something went wrong',
  code: 'SYSTEM_INTERNAL_FAILURE' as const,
  category: 'system' as const,
};

describe('MissionProtocolError', () => {
  test('serializes internal cause variants', () => {
    const causeError = new Error('Root cause');
    const error = new MissionProtocolError({
      ...baseOptions,
      cause: causeError,
    });
    const json = error.toJSON();
    expect(json.cause).toBe('Error: Root cause');

    const nested = new MissionProtocolError({
      ...baseOptions,
      message: 'Nested',
    });
    const nestedError = new MissionProtocolError({
      ...baseOptions,
      cause: nested,
    });
    const nestedJson = nestedError.toJSON();
    expect((nestedJson.cause as any).message).toBe('Nested');

    const stringCause = new MissionProtocolError({
      ...baseOptions,
      cause: 'string-cause',
    }).toJSON();
    expect(stringCause.cause).toBe('string-cause');

    const objectCause = new MissionProtocolError({
      ...baseOptions,
      cause: { foo: 'bar' },
    }).toJSON();
    expect(objectCause.cause).toBe('{"foo":"bar"}');

    const circular: any = {};
    circular.self = circular;
    const circularCause = new MissionProtocolError({
      ...baseOptions,
      cause: circular,
    }).toJSON();
    expect(circularCause.cause as string).toMatch(/Unserializable cause/);
  });

  test('toPublicObject hides stack and cause', () => {
    const cause = new MissionProtocolError({
      ...baseOptions,
      message: 'Nested cause',
    });
    const error = new MissionProtocolError({
      ...baseOptions,
      cause,
    });
    const publicObj = error.toPublicObject();
    expect(publicObj.stack).toBeUndefined();
    expect(publicObj.cause).toBeUndefined();
  });

  test('isMissionProtocolError type guard', () => {
    const error = new MissionProtocolError(baseOptions);
    expect(MissionProtocolError.isMissionProtocolError(error)).toBe(true);
    expect(MissionProtocolError.isMissionProtocolError(new Error('nope'))).toBe(false);
  });
});
