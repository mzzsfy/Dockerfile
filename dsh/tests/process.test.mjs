import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const implementation = await import('../environment.mjs');
const moduleUrl = new URL('../environment.mjs', import.meta.url).href;

test('后端执行返回stdout和真实退出码，不把失败当成功', async () => {
  assert.equal(typeof implementation.runManagedCommand, 'function');
  const result = await implementation.runManagedCommand(process.execPath, ['-e', 'process.stdout.write("1.26.1");process.exitCode=7'], { capture: true });
  assert.deepEqual(result, { code: 7, stdout: '1.26.1' });
});

test('挂起的后端检查超过期限被终止，不阻塞维护', async () => {
  assert.equal(typeof implementation.runManagedCommand, 'function');
  const result = await implementation.runManagedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { capture: true, timeoutMs: 100 });
  assert.notEqual(result.code, 0);
});

test('Linux嵌套包装共享外层任务组，超时后不遗留内层命令', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nested-'));
  const pidFile = path.join(root, 'pid');
  try {
    const inner = `const {runManagedCommand}=await import(${JSON.stringify(moduleUrl)}); await runManagedCommand('/bin/sh',['-c','trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done','test',${JSON.stringify(pidFile)}]);`;
    const result = await implementation.runManagedCommand(process.execPath, ['--input-type=module', '-e', inner], { capture: true, timeoutMs: 1000 });
    assert.notEqual(result.code, 0);
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    const status = `/proc/${pid}/stat`;
    if (fs.existsSync(status)) assert.equal(fs.readFileSync(status, 'utf8').split(') ')[1][0], 'Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Linux后端超时清理同组后代，继承worker标志不绕过管理', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-process-'));
  const pidFile = path.join(root, 'pid');
  const previous = process.env.DSH_ENV_GROUP;
  process.env.DSH_ENV_GROUP = '1';
  try {
    const result = await implementation.runManagedCommand('/bin/sh', ['-c', 'trap "" TERM; sh -c \'trap "" TERM; while :; do sleep 1; done\' & echo $! > "$1"; wait', 'test', pidFile], { capture: true, timeoutMs: 500 });
    assert.notEqual(result.code, 0);
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    const status = `/proc/${pid}/stat`;
    if (fs.existsSync(status)) assert.equal(fs.readFileSync(status, 'utf8').split(') ')[1][0], 'Z');
  } finally {
    if (previous === undefined) delete process.env.DSH_ENV_GROUP; else process.env.DSH_ENV_GROUP = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
