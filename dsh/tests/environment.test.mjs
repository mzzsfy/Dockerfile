import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const implementation = await import('../environment.mjs').catch(() => ({}));

test('DSH 默认通配绑定，显式地址原样作为单一参数并使用镜像 Node', () => {
  assert.equal(typeof implementation.dshServiceCommand, 'function');
  const command = implementation.dshServiceCommand({});
  assert.deepEqual(command, ['/usr/local/bin/node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open', '--host', '0.0.0.0']);
  assert.equal(implementation.dshServiceCommand({ DSH_HOST: '::' }).at(-1), '::');
  assert.equal(implementation.dshServiceCommand({ DSH_HOST: '' }).at(-1), '0.0.0.0');
});

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

test('源恢复按缺失、镜像原始内容、用户改动三态处理，钩子内容比对自愈', () => {
  assert.equal(typeof implementation.applySourceEntries, 'function', '缺少源恢复功能');
  const root = mkdtempSync(join(tmpdir(), 'dsh-src-'));
  const key = 'etc/apt/sources.list.d/debian.sources';
  const hook = 'etc/apt/apt.conf.d/99-dsh-source-snapshot';
  const file = relative => join(root, 'target', relative);
  const baseline = { [key]: createHash('sha256').update('image-original').digest('hex') };
  try {
    mkdirSync(join(root, 'extracted/etc/apt/sources.list.d'), { recursive: true });
    mkdirSync(join(root, 'extracted/etc/apt/apt.conf.d'), { recursive: true });
    mkdirSync(join(root, 'target/etc/apt/sources.list.d'), { recursive: true });
    mkdirSync(join(root, 'target/etc/apt/apt.conf.d'), { recursive: true });
    writeFileSync(join(root, 'extracted', key), 'snapshot');
    writeFileSync(join(root, 'extracted', hook), 'hook');
    writeFileSync(file(hook), 'stale');
    // 缺失时恢复
    implementation.applySourceEntries(join(root, 'extracted'), join(root, 'target'), baseline);
    assert.equal(readFileSync(file(key), 'utf8'), 'snapshot');
    assert.equal(readFileSync(file(hook), 'utf8'), 'hook');
    // 仍是镜像原始内容时用快照覆盖
    writeFileSync(file(key), 'image-original');
    implementation.applySourceEntries(join(root, 'extracted'), join(root, 'target'), baseline);
    assert.equal(readFileSync(file(key), 'utf8'), 'snapshot');
    // 本容器内的改动保留
    writeFileSync(file(key), 'user-edit');
    implementation.applySourceEntries(join(root, 'extracted'), join(root, 'target'), baseline);
    assert.equal(readFileSync(file(key), 'utf8'), 'user-edit');
    // 快照外的新增文件不受影响
    writeFileSync(file('etc/apt/sources.list.d/custom.list'), 'custom');
    implementation.applySourceEntries(join(root, 'extracted'), join(root, 'target'), baseline);
    assert.equal(readFileSync(file('etc/apt/sources.list.d/custom.list'), 'utf8'), 'custom');
    // 符号链接不作为文件复制（Windows 创建文件链接需要特权）
    if (process.platform !== 'win32') {
      symlinkSync('debian.sources', join(root, 'extracted/etc/apt/sources.list.d/link.list'), 'file');
      implementation.applySourceEntries(join(root, 'extracted'), join(root, 'target'), baseline);
      assert.equal(statSync(file('etc/apt/sources.list.d/link.list'), { throwIfNoEntry: false }), undefined, '符号链接不应被复制为普通文件');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('哈希基线只覆盖存在的源路径且跳过钩子自身', () => {
  assert.equal(typeof implementation.collectHashes, 'function', '缺少源基线采集');
  const root = mkdtempSync(join(tmpdir(), 'dsh-hash-'));
  try {
    assert.deepEqual(implementation.collectHashes(root), {});
    mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
    mkdirSync(join(root, 'etc/apt/apt.conf.d'), { recursive: true });
    writeFileSync(join(root, 'etc/apt/sources.list.d/debian.sources'), 'a');
    writeFileSync(join(root, 'etc/apt/apt.conf.d/99-dsh-source-snapshot'), 'hook');
    const hashes = implementation.collectHashes(root);
    assert.deepEqual(Object.keys(hashes), ['etc/apt/sources.list.d/debian.sources']);
    assert.equal(hashes['etc/apt/sources.list.d/debian.sources'], createHash('sha256').update('a').digest('hex'));
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
