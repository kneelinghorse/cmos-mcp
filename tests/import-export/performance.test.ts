import { TemplateImporter } from '../../src/import-export/template-importer';
import * as path from 'path';

/**
 * Performance test: Import validation completes in <1 second for typical templates (<100KB)
 * Uses skipSignatureVerification to avoid external key lookups during perf measurement.
 */
describe('Import Performance', () => {
  const baseDir = path.resolve(__dirname, '../../tests/test-data');

  const minimalTemplate = `
apiVersion: mission-template.v1
kind: MissionTemplate
metadata:
  name: perf-test
  version: 1.0.0
  author: tester
  signature:
    keyId: test
    algorithm: PGP-SHA256
    value: deadbeef
spec:
  description: Minimal template for performance testing
dependencies: []
`;

  it('imports a typical template under 1000ms', async () => {
    const importer = new TemplateImporter(baseDir);
    const start = Date.now();
    const result = await importer.importFromString(minimalTemplate, {
      skipSignatureVerification: true,
    });
    const elapsed = Date.now() - start;

    expect(result.validationReport.valid).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});
