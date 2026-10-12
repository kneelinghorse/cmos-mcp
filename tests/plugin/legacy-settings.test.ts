// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Both pre-package launchers must resolve the same settings/config folder as the installed server.
// ABOUTME: Fresh and legacy homes prove new-name precedence without moving or creating user data.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { node } from './fixtures';
import { resolveConfigDirectory } from '../../src/intelligence/legacy-compat';

const pluginCopies = ['plugins/reasonbook/hooks', 'plugins/reasonbook-chat/server'];

describe('pre-package settings compatibility', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-settings-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test.each(pluginCopies)(
    '%s preserves the existing record and gives the new spelling precedence',
    (copy) => {
      const moduleUrl = pathToFileURL(path.resolve(copy, 'legacy-compat.mjs')).href;
      const result = node(`import fs from 'node:fs'; import path from 'node:path';
      import {getSetting, resolveConfigDirectory} from ${JSON.stringify(moduleUrl)};
      const home=${JSON.stringify(home)};
      const fresh=resolveConfigDirectory({},home);
      const absent=!fs.existsSync(fresh);
      const old=path.join(home,'.config','cmos-mcp');fs.mkdirSync(old,{recursive:true});
      const legacy=resolveConfigDirectory({},home);
      const modern=path.join(home,'.config','rbook');fs.mkdirSync(modern,{recursive:true});
      const current=resolveConfigDirectory({},home);
      console.log(JSON.stringify({fresh,absent,legacy,current,
        explicit:resolveConfigDirectory({RBOOK_CONFIG_DIR:'/new',CMOS_CONFIG_DIR:'/old'},home),
        setting:getSetting('CMOS_AMBIENT',{RBOOK_AMBIENT:'off',CMOS_AMBIENT:'on'}),
        empty:getSetting('RBOOK_AMBIENT',{RBOOK_AMBIENT:'',CMOS_AMBIENT:'on'})}));`);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        fresh: path.join(home, '.config', 'rbook'),
        absent: true,
        legacy: path.join(home, '.config', 'cmos-mcp'),
        current: path.join(home, '.config', 'rbook'),
        explicit: '/new',
        setting: 'off',
        empty: '',
      });
    }
  );

  test.each(pluginCopies)(
    '%s matches the server when a new empty folder could hide an old registry',
    (copy) => {
      const old = path.join(home, '.config', 'cmos-mcp');
      const current = path.join(home, '.config', 'rbook');
      fs.mkdirSync(old, { recursive: true });
      fs.mkdirSync(current, { recursive: true });
      fs.writeFileSync(path.join(old, 'project-graph.sqlite'), 'fixture registry presence');
      const moduleUrl = pathToFileURL(path.resolve(copy, 'legacy-compat.mjs')).href;
      const result = node(`import {resolveConfigDirectory} from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(resolveConfigDirectory({},${JSON.stringify(home)})));`);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toBe(resolveConfigDirectory({}, home));
      expect(JSON.parse(result.stdout)).toBe(old);
    }
  );

  test.each(pluginCopies)(
    '%s refuses while config migration is incomplete, even with an explicit override',
    (copy) => {
      fs.mkdirSync(path.join(home, '.config'), { recursive: true });
      const moduleUrl = pathToFileURL(path.resolve(copy, 'legacy-compat.mjs')).href;
      for (const suffix of ['.json', '.lock']) {
        const marker = path.join(home, '.config', '.rbook-config-migration' + suffix);
        fs.writeFileSync(marker, '{}');
        try {
          const result = node(`import {resolveConfigDirectory} from ${JSON.stringify(moduleUrl)};
          try {resolveConfigDirectory({RBOOK_CONFIG_DIR:'/explicit'},${JSON.stringify(home)});process.stdout.write('opened');}
          catch(error) {process.stdout.write(error.message);}`);
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('migration');
          expect(result.stdout).not.toBe('opened');
        } finally {
          fs.unlinkSync(marker);
        }
      }
    }
  );

  test('both copies stay byte-identical so chat and coding installs cannot split their record', () => {
    const copies = pluginCopies.map((copy) =>
      fs.readFileSync(path.join(copy, 'legacy-compat.mjs'), 'utf8')
    );
    expect(copies[0]).toBe(copies[1]);
  });

  test('the developer manifest requests both spelling families for explicit settings', () => {
    const config = JSON.parse(fs.readFileSync('plugins/reasonbook/codex.mcp.json', 'utf8'));
    const server = Object.values(config.mcpServers)[0] as { env_vars?: string[] };
    expect(server.env_vars).toEqual(
      expect.arrayContaining([
        'RBOOK_CONFIG_DIR',
        'CMOS_CONFIG_DIR',
        'RBOOK_PROJECT_ROOT',
        'CMOS_PROJECT_ROOT',
        'RBOOK_OFFLINE_EMBEDDINGS',
        'CMOS_OFFLINE_EMBEDDINGS',
      ])
    );
  });
});
