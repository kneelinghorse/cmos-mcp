// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps every Codex entry on one validated install without using harness-private data.
// ABOUTME: Portable manifests, shared hooks and cold MCP startup must preserve the Claude entry contract.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { copiedPlugin, fixture, moduleUrl, node, packageCode, version } from './fixtures';

describe('the shared Codex plugin runtime', () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test.each(['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json'])(
    'the exact package pin can be read from %s alone',
    (manifest) => {
      const file = path.join(root, manifest);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ name: 'fixture', version }));
      const result = node(`import {readPluginVersion} from ${moduleUrl('install-state.mjs')};
        console.log(readPluginVersion(${JSON.stringify(root)}));`);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(result.stdout.trim()).toBe(version);
    }
  );

  test('shared SessionStart ignores harness data and removes its private launcher flag', () => {
    const plugin = copiedPlugin(root);
    const env = {
      PATH: '',
      RBOOK_CONFIG_DIR: path.join(root, 'config'),
      CLAUDE_PLUGIN_DATA: path.join(root, '.codex/plugins/data'),
      PLUGIN_DATA: path.join(root, '.codex/plugins/data'),
    };
    const result = node(`import fs from 'node:fs';import path from 'node:path';
      import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      import {writeMarker} from ${moduleUrl('install-state.mjs')};
      const contexts=[];const launches=[];const lines=[];
      const options={env:${JSON.stringify(env)},startInstaller:ctx=>contexts.push(ctx),
        launch:async(command,args)=>{launches.push(args);return 0},writeOut:text=>lines.push(text)};
      const args=['hook','session-start','--harness','codex','--install-root','shared','--hook-source','rbook-codex-plugin'];
      await run(args,options); const ctx=contexts[0];
      if(ctx){${packageCode('ctx.installRoot')} writeMarker(ctx,ctx.installRoot); await run(args,options); await run(['serve','--install-root','shared'],options);}
      console.log(JSON.stringify({contexts,launches,lines,privateExists:fs.existsSync(${JSON.stringify(path.join(root, '.codex'))})}));`);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const value = JSON.parse(result.stdout);
    expect(value.contexts).toHaveLength(1);
    expect(value.contexts[0].dataRoot).toBe(path.join(root, 'config/plugins'));
    expect(value.contexts[0].pointerPath).toBe(
      path.join(root, 'config/plugins/runtime/plugin-install.json')
    );
    expect(value.launches[0].slice(1)).toEqual([
      'hook',
      'session-start',
      '--harness',
      'codex',
      '--hook-source',
      'rbook-codex-plugin',
    ]);
    expect(value.launches[1].slice(1)).toEqual(['serve']);
    expect(value.launches[1][0]).toBe(value.launches[0][0]);
    expect(value.privateExists).toBe(false);
  });

  test('a cold shared server uses the installing responder, never npx', () => {
    const plugin = copiedPlugin(root);
    const result =
      node(`import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      let serving;let launched=0;
      const code=await run(['serve','--install-root','shared'],{
        env:{PATH:'',RBOOK_CONFIG_DIR:${JSON.stringify(path.join(root, 'config'))}},
        launch:async()=>{launched++;return 7},
        serveInstalling:async(ctx)=>{serving=ctx;},startInstaller:()=>{}});
      console.log(JSON.stringify({code,serving,launched}));`);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.code).toBe(0);
    expect(value.launched).toBe(0);
    expect(value.serving.dataRoot).toBe(path.join(root, 'config/plugins'));
  });

  test('shared hooks and servers ignore a same-version PATH package while Claude retains its fallback', () => {
    const plugin = copiedPlugin(root);
    const globalRoot = path.join(root, 'global');
    const globalBin = path.join(globalRoot, 'bin');
    const result = node(`import fs from 'node:fs';import path from 'node:path';
      import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      const globalRoot=${JSON.stringify(globalRoot)};${packageCode('globalRoot')}
      fs.mkdirSync(${JSON.stringify(globalBin)});
      fs.symlinkSync(path.join(globalRoot,'node_modules/@aquex/reasonbook/dist/bin.js'),path.join(${JSON.stringify(globalBin)},'reasonbook'));
      const env={PATH:${JSON.stringify(globalBin)},RBOOK_CONFIG_DIR:${JSON.stringify(path.join(root, 'config'))},CLAUDE_PLUGIN_DATA:${JSON.stringify(path.join(root, 'claude-data'))}};
      const workers=[];const servers=[];const launches=[];
      const options={env,startInstaller:ctx=>workers.push(ctx),serveInstalling:async ctx=>{servers.push(ctx)},launch:async(cmd,args)=>{launches.push(args);return 0},writeOut:()=>{}};
      await run(['hook','session-start','--install-root','shared'],options);
      await run(['serve','--install-root','shared'],options);
      const sharedLaunches=launches.length;
      await run(['serve'],options);
      console.log(JSON.stringify({workers:workers.length,servers:servers.length,sharedLaunches,launches}));`);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({ workers: 1, servers: 1, sharedLaunches: 0 });
    expect(value.launches).toHaveLength(1);
    expect(value.launches[0]).toEqual([
      fs.realpathSync(path.join(globalRoot, 'node_modules/@aquex/reasonbook/dist/bin.js')),
      'serve',
    ]);
  });

  test('unknown install-root values fail before package discovery or execution', () => {
    const plugin = copiedPlugin(root);
    const result =
      node(`import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
      let launched=0;const errors=[];const code=await run(['serve','--install-root','foreign'],{
        env:{PATH:'',RBOOK_CONFIG_DIR:${JSON.stringify(path.join(root, 'config'))}},
        launch:async()=>{launched++;return 0},writeError:e=>errors.push(e)});
      console.log(JSON.stringify({code,launched,errors}));`);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.code).toBe(1);
    expect(value.launched).toBe(0);
    expect(value.errors.join('')).toContain('--install-root');
  });

  test.each(['relative-config', ''])(
    'shared hooks and servers reject nonabsolute config override %p without changing legacy routing',
    (override) => {
      const plugin = copiedPlugin(root);
      const result =
        node(`import os from 'node:os';import {run} from ${JSON.stringify(pathToFileURL(path.join(plugin, 'hooks/run.mjs')).href)};
        os.homedir=()=>${JSON.stringify(root)};process.chdir(${JSON.stringify(root)});
        const errors=[];let executions=0;
        const options={env:{PATH:'',RBOOK_CONFIG_DIR:${JSON.stringify(override)}},
          launch:async()=>{executions++;return 7},startInstaller:()=>{executions++},
          serveInstalling:async()=>{executions++},writeOut:()=>{},writeError:text=>errors.push(text)};
        const hook=await run(['hook','session-start','--install-root','shared'],options);
        const serve=await run(['serve','--install-root','shared'],options);
        const sharedExecutions=executions;
        const legacy=await run(['feedback'],options);
        console.log(JSON.stringify({hook,serve,sharedExecutions,errors,legacy,executions}));`);
      expect(result.status).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value).toMatchObject({
        hook: 0,
        serve: 1,
        sharedExecutions: 0,
        legacy: 7,
        executions: 1,
      });
      expect(value.errors).toHaveLength(2);
      for (const error of value.errors)
        expect(error).toContain(
          'RBOOK_CONFIG_DIR (or its legacy equivalent) must be an absolute path'
        );
    }
  );
});
