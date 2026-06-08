import { describe, expect, test } from '@jest/globals';
import type { DomainInfo } from '../../src/types/tools';

const makeDomainInfo = (info: DomainInfo): DomainInfo => info;

describe('types/tools', () => {
  test('represents minimal domain info', () => {
    const info = makeDomainInfo({
      name: 'security-zero-trust',
      description: 'Zero trust rollout mission pack',
      version: '1.2.3',
    });

    expect(info.name).toBe('security-zero-trust');
    expect(info.description).toContain('Zero trust');
    expect(info.version).toBe('1.2.3');
    expect(info.author).toBeUndefined();
  });

  test('captures optional author metadata', () => {
    const info = makeDomainInfo({
      name: 'data-quality',
      description: 'Data quality audit',
      version: '2.0.0',
      author: 'Mission Protocol Team',
    });

    expect(info.author).toBe('Mission Protocol Team');
  });
});
