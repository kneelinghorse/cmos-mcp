// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Local-only fixtures for the plugin runtime's publication and process tests.
// ABOUTME: The fixture CLI uses the real native SQLite dependency without invoking npm or a network.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const hooks = path.resolve(__dirname, '../../plugins/cmos/hooks');
export const version: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
).version;
export const nativePackage = path.dirname(require.resolve('better-sqlite3/package.json'));

export function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-plugin-test-'));
}

export function node(code: string, env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 15000,
    input,
    env: { ...process.env, ...env },
  });
}

export function moduleUrl(name: string): string {
  return JSON.stringify(pathToFileURL(path.join(hooks, name)).href);
}

export function contextCode(root: string): string {
  return `const ctx = createContext(${JSON.stringify({
    version,
    dataRoot: path.join(root, 'data'),
    configDir: path.join(root, 'config'),
  })});`;
}

export function packageCode(rootExpression: string, packageVersion = version): string {
  return `{
    const pkg = path.join(${rootExpression}, 'node_modules', '@aquex', 'cmos-mcp');
    fs.mkdirSync(path.join(pkg, 'dist'), {recursive:true});
    fs.mkdirSync(path.join(pkg, 'node_modules'), {recursive:true});
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name:'@aquex/cmos-mcp',version:${JSON.stringify(packageVersion)},bin:{'cmos-mcp':'dist/bin.js'}}));
    fs.writeFileSync(path.join(pkg, 'dist/bin.js'), ${JSON.stringify(`if(process.argv.includes('--version')) console.log('cmos-mcp ${packageVersion}'); else { process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({args:process.argv.slice(2)})); process.exitCode=Number(process.env.FIXTURE_EXIT || 0); }); }`)});
    fs.symlinkSync(${JSON.stringify(nativePackage)}, path.join(pkg, 'node_modules/better-sqlite3'), 'dir');
  }`;
}

export function copiedPlugin(root: string): string {
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'cmos', version })
  );
  fs.cpSync(hooks, path.join(plugin, 'hooks'), { recursive: true });
  return plugin;
}
