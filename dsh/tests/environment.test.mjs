import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const implementation = await import('../environment.mjs').catch(() => ({}));

test('映射创建后写入目标保存到源，重复执行不覆盖目标内容', () => {
  assert.equal(typeof implementation.applyMapping, 'function');
  const root = mkdtempSync(join(tmpdir(), 'dsh-map-'));
  try {
    const source = join(root, 'saved');
    const target = join(root, 'data', 'tool');
    implementation.applyMapping({ source, target });
    writeFileSync(join(target, 'file'), 'persistent');
    implementation.applyMapping({ source, target });
    assert.equal(readFileSync(join(source, 'file'), 'utf8'), 'persistent');
    const conflict = join(root, 'existing');
    mkdirSync(conflict);
    writeFileSync(join(conflict, 'keep'), 'original');
    assert.throws(() => implementation.applyMapping({ source, target: conflict }));
    assert.equal(readFileSync(join(conflict, 'keep'), 'utf8'), 'original');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apt 事务保留未恢复目标，记录新增软件并取消已卸载目标', () => {
  assert.equal(typeof implementation.mergeTargets, 'function');
  const before = { installed: ['base', 'old'], manual: ['base', 'old'] };
  const after = { installed: ['base', 'new', 'dependency'], manual: ['base', 'new'] };
  assert.deepEqual(implementation.mergeTargets(['pending', 'old'], ['base'], before, after, []), ['new', 'pending']);
  assert.deepEqual(implementation.mergeTargets(['pending'], ['base'], before, before, ['pending']), []);
  assert.deepEqual(implementation.mergeTargets(['old'], [], before, { installed: ['base'], manual: ['base'], incomplete: ['old'] }, []), ['old']);
});

test('精确卸载请求取消待恢复目标，模拟和只下载不改变目标', () => {
  assert.equal(typeof implementation.removalIntent, 'function');
  assert.deepEqual(implementation.removalIntent(['remove', '-y', 'ripgrep:amd64']), ['ripgrep:amd64']);
  assert.deepEqual(implementation.removalIntent(['install', 'ripgrep-', 'curl']), ['ripgrep']);
  assert.deepEqual(implementation.removalIntent(['--simulate', 'remove', 'ripgrep']), []);
  assert.deepEqual(implementation.removalIntent(['remove', '--download-only', 'ripgrep']), []);
  assert.deepEqual(implementation.removalIntent(['-ys', 'remove', 'ripgrep']), []);
  assert.deepEqual(implementation.removalIntent(['-yd', 'remove', 'ripgrep']), []);
  assert.deepEqual(implementation.removalIntent(['-o', 'APT::Get::Simulate=true', 'remove', 'ripgrep']), []);
  assert.deepEqual(implementation.removalIntent(['remove', 'ripgrep', '-oAPT::Get::Download-Only=1']), []);
});

test('修复半安装包后记录恢复目标，跨容器核对不误判旧包卸载', () => {
  assert.deepEqual(implementation.mergeTargets([], [], { installed: [], manual: ['foo'], incomplete: ['foo'] }, { installed: ['foo'], manual: ['foo'] }, []), ['foo']);
  assert.equal(typeof implementation.reconcileTargets, 'function');
  const pending = { container: 'old', before: { installed: ['curl', 'rg'], manual: ['curl', 'rg'] }, cancelled: [] };
  assert.deepEqual(implementation.reconcileTargets(['curl', 'rg'], [], pending, { installed: [], manual: [] }, 'new'), ['curl', 'rg']);
});

test('固定前置脚本失败会传播退出结果，缺省脚本允许启动', async () => {
  assert.equal(typeof implementation.runHook, 'function');
  const root = mkdtempSync(join(tmpdir(), 'dsh-hook-'));
  try {
    assert.equal(await implementation.runHook(join(root, 'missing.sh')), 0);
    const hook = join(root, 'before-start.sh');
    writeFileSync(hook, 'exit 7\n');
    assert.equal(await implementation.runHook(hook, process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh'), 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('路径文本将持久源目录映射到目标并拒绝覆盖系统目录', () => {
  assert.equal(typeof implementation.parseMappings, 'function', '缺少路径配置功能');
  assert.deepEqual(implementation.parseMappings('# comment\n/root/test1:/data/test1\n'), [
    { source: '/root/test1', target: '/data/test1' },
  ]);
  for (const input of ['/root/x:/usr', '/root/x:/usr/local/bin', '/root/x:/etc/x', '/tmp/x:/data/x', '/root/x:/root/x/y', '/root/x:/data/../usr']) {
    assert.throws(() => implementation.parseMappings(input), undefined, input);
  }
  assert.throws(() => implementation.parseMappings('/root/a:/data/a\n/root/b:/data/a/b'));
});
