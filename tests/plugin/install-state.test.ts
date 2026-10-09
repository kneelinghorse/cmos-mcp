// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Readiness means exact package identity and executable native SQLite, never a version string.
// ABOUTME: Pointer and ABI fixtures prove that an untrusted or half-published path cannot become executable.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contextCode, fixture, moduleUrl, node, packageCode } from './fixtures';

describe('plugin installation readiness', () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(body: string) {
    const result = node(`import fs from 'node:fs'; import path from 'node:path';
      import {createContext, validateInstall, writeMarker, findReady, writePointer, validatePackage, findPathPackage} from ${moduleUrl('install-state.mjs')};
      ${contextCode(root)} ${body}`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  test('a native-ready candidate is invisible until its marker and atomic rename both land', () => {
    expect(
      run(`const candidate=ctx.installRoot+'.tmp-test'; ${packageCode('candidate')}
      const before=validateInstall(ctx, candidate); writeMarker(ctx,candidate);
      const marked=validateInstall(ctx,candidate); const unpublished=findReady(ctx, {PATH:''});
      fs.renameSync(candidate,ctx.installRoot); const published=findReady(ctx,{PATH:''});
      console.log(JSON.stringify({before:!!before,marked:!!marked,unpublished:!!unpublished,published:!!published}));`)
    ).toEqual({ before: false, marked: true, unpublished: false, published: true });
  });

  test('a forged pointer outside the current data root never executes or becomes ready', () => {
    expect(
      run(`const outside=path.join(ctx.configDir,'forged'); ${packageCode('outside')}
      writeMarker(ctx,outside); fs.mkdirSync(path.dirname(ctx.pointerPath),{recursive:true});
      fs.writeFileSync(ctx.pointerPath,JSON.stringify({...ctx.identity,installRoot:outside}));
      console.log(JSON.stringify({ready:!!findReady(ctx,{PATH:''})}));`)
    ).toEqual({ ready: false });
  });

  test('an expected install path cannot redirect readiness through an outside symlink', () => {
    expect(
      run(`const outside=path.join(ctx.configDir,'forged'); ${packageCode('outside')}
      writeMarker(ctx,outside); fs.mkdirSync(ctx.dataRoot,{recursive:true}); fs.symlinkSync(outside,ctx.installRoot,'dir');
      console.log(JSON.stringify({ready:!!findReady(ctx,{PATH:''})}));`)
    ).toEqual({ ready: false });
  });

  test('changed ABI rejects an old marker and preserves the old installation', () => {
    expect(
      run(`${packageCode('ctx.installRoot')} writeMarker(ctx,ctx.installRoot);
      const changed=createContext({...ctx,abi:'different-abi'});
      console.log(JSON.stringify({old:!!validateInstall(ctx,ctx.installRoot),changed:!!findReady(changed,{PATH:''}),exists:fs.existsSync(ctx.installRoot)}));`)
    ).toEqual({ old: true, changed: false, exists: true });
  });

  test('exact version and the real native query are both required', () => {
    expect(
      run(`${packageCode('ctx.installRoot', '0.0.1')} writeMarker(ctx,ctx.installRoot);
      const wrongVersion=validateInstall(ctx,ctx.installRoot);
      const pkg=path.join(ctx.installRoot,'node_modules/@aquex/cmos-mcp');
      fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@aquex/cmos-mcp',version:ctx.version,bin:{'cmos-mcp':'dist/bin.js'}}));
      fs.unlinkSync(path.join(pkg,'node_modules/better-sqlite3'));
      console.log(JSON.stringify({wrongVersion:!!wrongVersion,noNative:!!validateInstall(ctx,ctx.installRoot)}));`)
    ).toEqual({ wrongVersion: false, noNative: false });
  });

  test('a validated PATH package must own its CLI and native dependency', () => {
    expect(
      run(`${packageCode('ctx.installRoot')} const bin=path.join(ctx.dataRoot,'bin'); fs.mkdirSync(bin);
      fs.symlinkSync(path.join(ctx.installRoot,'node_modules/@aquex/cmos-mcp/dist/bin.js'),path.join(bin,'cmos-mcp'));
      const ready=findPathPackage(ctx,{PATH:bin});
      console.log(JSON.stringify({ready:!!ready}));`)
    ).toEqual({ ready: true });
  });

  test('a valid CLI that loads beyond 200ms remains eligible within the shared 400ms budget', () => {
    const result =
      run(`${packageCode('ctx.installRoot')} const bin=path.join(ctx.dataRoot,'bin'); fs.mkdirSync(bin);
      const cli=path.join(ctx.installRoot,'node_modules/@aquex/cmos-mcp/dist/bin.js');
      fs.writeFileSync(cli,'setTimeout(()=>console.log('+JSON.stringify('cmos-mcp '+ctx.version)+'),225)');
      fs.symlinkSync(cli,path.join(bin,'cmos-mcp'));
      console.log(JSON.stringify({ready:!!findPathPackage(ctx,{PATH:bin})}));`);
    expect(result).toEqual({ ready: true });
  });

  test.each(['mismatch', 'timeout'])(
    'a PATH CLI with %s version output cannot become ready',
    (reason) => {
      const script =
        reason === 'mismatch' ? "console.log('cmos-mcp 0.0.1')" : 'setInterval(()=>{},1000)';
      const result =
        run(`${packageCode('ctx.installRoot')} const bin=path.join(ctx.dataRoot,'bin'); fs.mkdirSync(bin);
      const cli=path.join(ctx.installRoot,'node_modules/@aquex/cmos-mcp/dist/bin.js');
      fs.writeFileSync(cli,${JSON.stringify(script)});fs.symlinkSync(cli,path.join(bin,'cmos-mcp'));
      const started=Date.now();const ready=findPathPackage(ctx,{PATH:bin+path.delimiter+bin});
      console.log(JSON.stringify({ready:!!ready,elapsed:Date.now()-started}));`);
      expect(result.ready).toBe(false);
      expect(result.elapsed).toBeLessThan(1500);
    }
  );

  test('PATH aliases cannot multiply the bounded executable check for the same package', () => {
    const result = run(`const bin=path.join(ctx.dataRoot,'bin'); ${packageCode('bin')}
      const cli=path.join(bin,'node_modules/@aquex/cmos-mcp/dist/bin.js');const calls=path.join(ctx.dataRoot,'calls');
      fs.writeFileSync(cli,"require('node:fs').appendFileSync("+JSON.stringify(calls)+",'x');console.log('cmos-mcp 0.0.1')");
      fs.symlinkSync(cli,path.join(bin,'cmos-mcp'));fs.symlinkSync(bin,bin+'-alias','dir');
      const ready=findPathPackage(ctx,{PATH:bin+path.delimiter+bin+'-alias'});
      console.log(JSON.stringify({ready:!!ready,calls:fs.readFileSync(calls,'utf8').length}));`);
    expect(result).toEqual({ ready: false, calls: 1 });
  });

  test('distinct hung PATH packages share one executable-check budget', () => {
    const result =
      run(`const first=path.join(ctx.dataRoot,'first'); const second=path.join(ctx.dataRoot,'second');
      ${packageCode('first')} ${packageCode('second')}
      for(const bin of [first,second]) {const cli=path.join(bin,'node_modules/@aquex/cmos-mcp/dist/bin.js');
        fs.writeFileSync(cli,"require('node:fs').writeFileSync("+JSON.stringify(path.join(bin,'launched'))+",'yes');setInterval(()=>{},1000)");fs.symlinkSync(cli,path.join(bin,'cmos-mcp'));}
      const ready=findPathPackage(ctx,{PATH:first+path.delimiter+second});
      console.log(JSON.stringify({ready:!!ready,secondLaunched:fs.existsSync(path.join(second,'launched'))}));`);
    expect(result).toEqual({ ready: false, secondLaunched: false });
  });

  test('pointer records an exact identity and is revalidated on read', () => {
    const result =
      run(`${packageCode('ctx.installRoot')} writeMarker(ctx,ctx.installRoot); writePointer(ctx);
      const pointer=JSON.parse(fs.readFileSync(ctx.pointerPath,'utf8')); pointer.abi='wrong';
      fs.writeFileSync(ctx.pointerPath,JSON.stringify(pointer)); fs.rmSync(ctx.installRoot,{recursive:true});
      console.log(JSON.stringify({ready:!!findReady(ctx,{PATH:''}),path:pointer.installRoot}));`);
    expect(result.ready).toBe(false);
    expect(result.path).toContain(path.join(root, 'data'));
  });
});
