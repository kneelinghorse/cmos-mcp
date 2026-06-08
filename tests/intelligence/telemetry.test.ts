import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  emitTelemetryError,
  emitTelemetryInfo,
  emitTelemetryWarning,
  getTelemetryLevel,
  registerTelemetryHandler,
  setTelemetryLevel,
} from '../../src/intelligence/telemetry';

describe('telemetry utilities', () => {
  beforeEach(() => {
    registerTelemetryHandler(null);
    setTelemetryLevel('warning');
  });

  afterEach(() => {
    registerTelemetryHandler(null);
  });

  it('invokes registered handler with warning event', () => {
    const handler = jest.fn();
    registerTelemetryHandler(handler);

    emitTelemetryWarning('unit-test', 'handler invoked', { detail: 1 });

    expect(handler).toHaveBeenCalledWith({
      source: 'unit-test',
      level: 'warning',
      message: 'handler invoked',
      context: { detail: 1 },
    });
  });

  it('falls back to console when handler throws', () => {
    const error = new Error('handler failure');
    registerTelemetryHandler(() => {
      throw error;
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    emitTelemetryWarning('unit-test', 'handler error path');

    expect(warnSpy).toHaveBeenCalledWith('[Telemetry handler error] handler failure');
    expect(warnSpy).toHaveBeenCalledWith('[Telemetry][unit-test] handler error path');

    warnSpy.mockRestore();
  });

  it('stringifies non-error handler failures when falling back to console', () => {
    registerTelemetryHandler(() => {
      throw 'string failure';
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    emitTelemetryWarning('unit-test', 'string error path');

    expect(warnSpy).toHaveBeenCalledWith('[Telemetry handler error] string failure');
    warnSpy.mockRestore();
  });

  it('suppresses warnings when telemetry level is set to error', () => {
    const handler = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerTelemetryHandler(handler);

    setTelemetryLevel('error');
    emitTelemetryWarning('unit-test', 'should not emit');

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits info events when level lowered to info', () => {
    const handler = jest.fn();
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    registerTelemetryHandler(handler);

    setTelemetryLevel('info');
    emitTelemetryInfo('unit-test', 'info event', { flag: true });

    expect(handler).toHaveBeenCalledWith({
      source: 'unit-test',
      level: 'info',
      message: 'info event',
      context: { flag: true },
    });
    expect(infoSpy).not.toHaveBeenCalled(); // handler retained event, so console not used

    handler.mockReset();
    registerTelemetryHandler(null);

    emitTelemetryInfo('unit-test', 'console info');
    expect(infoSpy).toHaveBeenCalledWith('[Telemetry][unit-test] console info');

    infoSpy.mockRestore();
  });

  it('reports current telemetry level', () => {
    expect(getTelemetryLevel()).toBe('warning');
    setTelemetryLevel('info');
    expect(getTelemetryLevel()).toBe('info');
    setTelemetryLevel('error');
    expect(getTelemetryLevel()).toBe('error');
  });

  it('uses console.error for error level when no handler present', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    emitTelemetryError('unit-test', 'critical failure', { severity: 'high' });

    expect(errorSpy).toHaveBeenCalledWith('[Telemetry][unit-test] critical failure', {
      severity: 'high',
    });
    errorSpy.mockRestore();
  });

  it('honors environment configuration when initializing telemetry level', () => {
    const originalLevel = process.env.MISSION_TELEMETRY_LEVEL;
    const originalProtocolLevel = process.env.MISSION_PROTOCOL_TELEMETRY_LEVEL;

    jest.resetModules();
    process.env.MISSION_TELEMETRY_LEVEL = 'INFO';

    jest.isolateModules(() => {
      const telemetry = require('../../src/intelligence/telemetry');
      expect(telemetry.getTelemetryLevel()).toBe('info');
    });

    jest.resetModules();
    process.env.MISSION_TELEMETRY_LEVEL = 'verbose';
    process.env.MISSION_PROTOCOL_TELEMETRY_LEVEL = 'error';

    jest.isolateModules(() => {
      const telemetry = require('../../src/intelligence/telemetry');
      expect(telemetry.getTelemetryLevel()).toBe('error');
    });

    process.env.MISSION_TELEMETRY_LEVEL = originalLevel;
    process.env.MISSION_PROTOCOL_TELEMETRY_LEVEL = originalProtocolLevel;
    jest.resetModules();
  });

  it('logs info-level events to console when no handler or context are provided', () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    registerTelemetryHandler(null);

    setTelemetryLevel('info');
    emitTelemetryInfo('unit-test', 'context-free event');

    expect(infoSpy).toHaveBeenCalledWith('[Telemetry][unit-test] context-free event');
    infoSpy.mockRestore();
  });
});
