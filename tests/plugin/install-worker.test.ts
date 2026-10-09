// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Process-level installer tests exercise competing workers and crashes at publication boundaries.
// ABOUTME: Unknown lock owners fail open without takeover; only demonstrably dead ownership is reclaimed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { contextCode, fixture, moduleUrl, node, packageCode } from './fixtures';

describe('plugin installer publication', () => {
  let root: string;
  let children: ChildProcess[];
  beforeEach(() => {
    root = fixture();
    children = [];
  });
  afterEach(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const imports = `import fs from 'node:fs'; import path from 'node:path';
    import {createContext, validateInstall, writeMarker} from ${moduleUrl('install-state.mjs')};
    import {runInstall, acquireLock, releaseLock} from ${moduleUrl('install-worker.mjs')};`;

  function worker(body: string) {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `${imports} ${contextCode(root)} ${body}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(child);
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr!.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const done = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, done };
  }
  async function waitFor(file: string) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(file)).toBe(true);
  }
  function installCode(extra = '') {
    return `async candidate => {${packageCode('candidate')} ${extra}}`;
  }
  function probe() {
    const result = node(
      `${imports} ${contextCode(root)} console.log(JSON.stringify({ready:!!validateInstall(ctx)}));`
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout).ready;
  }

  test('concurrent first sessions publish exactly one immutable complete installation', async () => {
    const body = `console.log(await runInstall(ctx,{installPackage:${installCode(`fs.appendFileSync(${JSON.stringify(path.join(root, 'installs'))},'install'+String.fromCharCode(10)); await new Promise(r=>setTimeout(r,120));`)}}));`;
    const results = await Promise.all([worker(body).done, worker(body).done]);
    expect(results.every((result) => result.code === 0)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'installs'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(probe()).toBe(true);
    const next = await worker(
      `console.log(await runInstall(ctx,{installPackage:async()=>{throw Error('must not replace valid install')}}));`
    ).done;
    expect(next.stdout.trim()).toBe('ready');
  });

  test('a killed installer leaves no ready half and a later worker recovers its lock', async () => {
    const started = path.join(root, 'started');
    const first = worker(
      `await runInstall(ctx,{installPackage:${installCode(`fs.writeFileSync(${JSON.stringify(started)},'yes'); await new Promise(()=>setInterval(()=>{},1000));`)}});`
    );
    await waitFor(started);
    expect(probe()).toBe(false);
    first.child.kill('SIGKILL');
    await first.done;
    const recovered = await worker(
      `console.log(await runInstall(ctx,{installPackage:${installCode()}}));`
    ).done;
    expect(recovered.code).toBe(0);
    expect(recovered.stdout.trim()).toBe('installed');
    expect(probe()).toBe(true);
  });

  test.each(['beforePublish', 'afterPublish'])(
    'a crash at %s never advertises a half install',
    async (boundary) => {
      const result = await worker(
        `await runInstall(ctx,{installPackage:${installCode()},${boundary}:()=>process.kill(process.pid,'SIGKILL')});`
      ).done;
      expect(result.signal).toBe('SIGKILL');
      expect(probe()).toBe(boundary === 'afterPublish');
      const recovered = await worker(
        `console.log(await runInstall(ctx,{installPackage:${installCode()}}));`
      ).done;
      expect(recovered.code).toBe(0);
      expect(probe()).toBe(true);
    }
  );

  test('concurrent dead-owner recovery cannot remove the new live owner', async () => {
    await worker(`acquireLock(ctx); process.kill(process.pid,'SIGKILL');`).done;
    const acquired = path.join(root, 'acquired');
    const body = `const lock=acquireLock(ctx); if(lock){fs.appendFileSync(${JSON.stringify(acquired)},'owner'+String.fromCharCode(10)); await new Promise(r=>setTimeout(r,200)); releaseLock(lock);} console.log(!!lock);`;
    const results = await Promise.all([worker(body).done, worker(body).done, worker(body).done]);
    expect(results.every((result) => result.code === 0)).toBe(true);
    expect(fs.readFileSync(acquired, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('a crashed recovery owner is itself reclaimable without an abandoned recovery mutex', async () => {
    await worker(`acquireLock(ctx); process.kill(process.pid,'SIGKILL');`).done;
    const crashed = await worker(
      `acquireLock(ctx,{afterRecoveryClaim:()=>process.kill(process.pid,'SIGKILL')});`
    ).done;
    expect(crashed.signal).toBe('SIGKILL');
    const recovered = await worker(
      `const lock=acquireLock(ctx); console.log(!!lock); if(lock)releaseLock(lock);`
    ).done;
    expect(recovered.stdout.trim()).toBe('true');
  });

  test('recovery chains have a finite limit and never guess past an unknown owner', async () => {
    const dead = await worker(`console.log(process.pid);`).done;
    const result =
      await worker(`fs.mkdirSync(ctx.dataRoot,{recursive:true});const deadPid=${Number(dead.stdout.trim())};
      let token='00000000-0000-0000-0000-000000000000';
      fs.writeFileSync(ctx.installRoot+'.lock',JSON.stringify({pid:deadPid,token}));
      for(let index=1;index<=32;index++){const next='00000000-0000-0000-0000-'+String(index).padStart(12,'0');fs.writeFileSync(ctx.installRoot+'.lock.recover-'+token,JSON.stringify({pid:deadPid,token:next}));token=next;}
      console.log(!!acquireLock(ctx));`).done;
    expect(result.stdout.trim()).toBe('false');
    expect(result.stderr).toContain('recovery chain limit reached');
  });

  test('age cannot steal a live owner; partial unknown records stop with a bounded diagnostic', async () => {
    const alive = path.join(root, 'alive');
    const owner = worker(
      `const lock=acquireLock(ctx); const old=new Date(Date.now()-86400000);fs.utimesSync(lock.path,old,old);fs.writeFileSync(${JSON.stringify(alive)},'yes'); await new Promise(()=>setInterval(()=>{},1000));`
    );
    await waitFor(alive);
    const contender = await worker(`console.log(!!acquireLock(ctx));`).done;
    expect(contender.stdout.trim()).toBe('false');
    owner.child.kill('SIGKILL');
    await owner.done;
    const unknown = await worker(
      `fs.writeFileSync(ctx.installRoot+'.lock','{'); console.log(!!acquireLock(ctx));`
    ).done;
    expect(unknown.stdout.trim()).toBe('false');
    expect(unknown.stderr).toContain('unknown lock owner');
  });

  test('only the owning token can release a lock or remove an incomplete destination', async () => {
    const result =
      await worker(`const lock=acquireLock(ctx); releaseLock({...lock,token:'wrong'});const retained=fs.existsSync(lock.path);releaseLock(lock);
      fs.mkdirSync(ctx.installRoot,{recursive:true});fs.writeFileSync(path.join(ctx.installRoot,'incomplete'),'yes');
      const result=await runInstall(ctx,{installPackage:${installCode()}}); console.log(JSON.stringify({retained,result,ready:!!validateInstall(ctx)}));`)
        .done;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ retained: true, result: 'installed', ready: true });
  });
});
