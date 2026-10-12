// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The hook's canonical identity reader must stay independent of provenance-write dependencies.
// ABOUTME: The historical genesis export remains the same function and shares disclosure state.

describe('dependency-light canonical project identity', () => {
  it('loads first-prompt recall without the ULID write dependency', () => {
    jest.doMock('ulid', () => {
      throw new Error('The read-only hook must not load the provenance-write dependency.');
    });
    try {
      jest.isolateModules(() => {
        expect(() => require('../../../src/tools/rbook/first-prompt-recall')).not.toThrow();
      });
    } finally {
      jest.dontMock('ulid');
    }
  });

  it('keeps the genesis export identical to the canonical reader', () => {
    jest.isolateModules(() => {
      const canonical = require('../../../src/tools/rbook/project-id');
      const historical = require('../../../src/tools/rbook/genesis-columns');
      expect(historical.getProjectId).toBe(canonical.getProjectId);
    });
  });

  it('keeps the supersession keyword export identical to the hook reader', () => {
    jest.isolateModules(() => {
      const canonical = require('../../../src/tools/rbook/keyword-extraction');
      const historical = require('../../../src/tools/rbook/supersession-detection');
      expect(historical.extractKeywords).toBe(canonical.extractKeywords);
    });
  });
});
