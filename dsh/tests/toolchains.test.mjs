import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const implementation = await import('../toolchains.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture(t) {
  assert.equal(typeof implementation.createToolchains, 'function', '缺少 createToolchains 实现');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-toolchains-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const calls = [], logs = [];
  const latest = new Map([['go@latest', '1.24.3'], ['go@1.24', '1.24.3'], ['java@temurin-21', 'temurin-21.0.6'], ['python@latest', '3.13.2']]);
  const failures = new Set();
  const responses = new Map();
  const installPath = spec => path.join(dataDir, 'installs', ...spec.split('@'));
  const commands = { go: ['go', 'gofmt'], java: ['java', 'javac', 'jar', 'javadoc', 'jshell'], python: ['python', 'python3', 'pip', 'pip3'] };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const key = command === '/usr/local/bin/mise' ? args.join(' ') : `probe ${path.basename(command)}`;
    if (responses.has(key)) return { code: 0, stdout: responses.get(key) };
    if (failures.has(key)) return { code: 7, stdout: '' };
    if (command !== '/usr/local/bin/mise') return { code: 0, stdout: 'version OK' };
    const [action, spec] = args;
    const dir = installPath(spec);
    if (action === 'latest') return { code: 0, stdout: latest.get(spec) ?? spec.split('@')[1] };
    if (action === 'install') {
      await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
      for (const name of commands[spec.split('@')[0]]) await fs.writeFile(path.join(dir, 'bin', name), 'fake executable', { mode: 0o755 });
      return { code: 0, stdout: '' };
    }
    if (action === 'where') return { code: 0, stdout: `${dir}\n` };
    if (action === 'uninstall') { await fs.rm(dir, { recursive: true, force: true }); return { code: 0, stdout: '' }; }
    if (action === 'env') return { code: 0, stdout: JSON.stringify({ PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH || ''}`, ...(spec.startsWith('java@') ? { JAVA_HOME: dir } : {}) }) };
    throw new Error(`不支持的 mise 命令 ${args.join(' ')}`);
  };
  const api = implementation.createToolchains({ root, dataDir, run, log: value => logs.push(value) });
  return { api, root, dataDir, calls, logs, latest, failures, responses, installPath, registry: () => fs.readFile(path.join(root, 'registry.json'), 'utf8') };
}

test('Given 无登记 When 安装默认 go/python/jdk Then 精确安装后持久化受限系列并隔离 mise', async t => {
  const f = await fixture(t);
  const previous = process.env.MISE_EVIL;
  process.env.MISE_EVIL = 'project';
  t.after(() => previous === undefined ? delete process.env.MISE_EVIL : process.env.MISE_EVIL = previous);
  await f.api.install('go');
  await f.api.install('python');
  await f.api.install('jdk');
  const registry = JSON.parse(await f.registry());
  assert.equal(registry.schema, 1);
  assert.equal(registry.tools.go.current, '1.24.3');
  assert.equal(registry.tools.go.versions['1.24.3'].request, '1.24');
  assert.equal(registry.tools.python.versions['3.13.2'].request, '3.13');
  assert.equal(registry.tools.java.versions['temurin-21.0.6'].request, 'temurin-21');
  for (const call of f.calls.filter(call => call.command === '/usr/local/bin/mise')) {
    assert.equal(call.options.cwd, path.join(f.root, 'config'));
    assert.equal(call.options.env.MISE_EVIL, undefined);
    assert.equal(call.options.env.MISE_DATA_DIR, f.dataDir);
    assert.equal(call.options.env.MISE_CACHE_DIR, path.join(f.root, 'cache'));
    assert.equal(call.options.env.MISE_CONFIG_DIR, path.join(f.root, 'config'));
    assert.equal(call.options.env.MISE_GLOBAL_CONFIG_FILE, path.join(f.root, 'config', 'config.toml'));
    assert.equal(call.options.env.MISE_IGNORED_CONFIG_PATHS, '/');
    assert.equal(call.options.env.MISE_AUTO_INSTALL, 'false');
    assert.equal(call.options.env.MISE_NO_CONFIG, '1');
  }
  assert.equal(await fs.readFile(path.join(f.root, 'config', 'config.toml'), 'utf8'), '');
  assert.ok(f.calls.some(call => call.command === path.join(f.installPath('go@1.24.3'), 'bin', 'go') && call.args[0] === 'version'));
  assert.ok(f.calls.some(call => call.command === path.join(f.installPath('java@temurin-21.0.6'), 'bin', 'java') && call.args[0] === '-version'));
  assert.ok(!f.calls.some(call => call.command === '/usr/local/bin/mise' && call.args[0] === 'use'));
});

for (const phase of ['install go@1.24.4', 'where go@1.24.4', 'probe go']) {
  test(`Given 旧 current When ${phase} 失败 Then registry 字节不变`, async t => {
    const f = await fixture(t);
    await f.api.install('go@1.24.3');
    const before = await f.registry();
    f.failures.add(phase);
    await assert.rejects(f.api.install('go@1.24.4'));
    assert.equal(await f.registry(), before);
  });
}

test('Given 范围 current When upgrade Then 仅在原系列查 latest 并安装新补丁', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  f.latest.set('go@1.24', '1.24.10');
  f.calls.length = 0;
  await f.api.upgrade('go');
  assert.equal(JSON.parse(await f.registry()).tools.go.current, '1.24.10');
  assert.deepEqual(f.calls.filter(c => c.command === '/usr/local/bin/mise' && c.args[0] === 'latest').map(c => c.args), [['latest', 'go@1.24']]);
});

test('Given 精确 current When upgrade 全部 Then 精确固定且不查 latest', async t => {
  const f = await fixture(t);
  await f.api.install('go@1.24.3');
  f.calls.length = 0;
  await f.api.upgrade();
  assert.equal(JSON.parse(await f.registry()).tools.go.current, '1.24.3');
  assert.equal(f.calls.length, 0);
});

test('Given 多个已注册版本 When use 范围 Then 选择语义最高版本且无网络', async t => {
  const f = await fixture(t);
  for (const version of ['1.24.10', '1.24.9', '1.25.1']) await f.api.install(`go@${version}`);
  f.calls.length = 0;
  await f.api.use('go@1.24');
  assert.equal(JSON.parse(await f.registry()).tools.go.current, '1.24.10');
  assert.ok(f.logs.some(value => String(value).includes('1.24.10')));
  assert.ok(!f.calls.some(c => c.command === '/usr/local/bin/mise' && ['latest', 'install', 'use'].includes(c.args[0])));
  await assert.rejects(f.api.use('go@1.23'));
});

test('Given current 与历史版本 When remove Then 拒绝 current 且仅成功卸载后删除登记', async t => {
  const f = await fixture(t);
  await f.api.install('go@1.24.3');
  await f.api.install('go@1.25.1');
  await assert.rejects(f.api.remove('go@1.25.1'));
  f.failures.add('uninstall go@1.24.3');
  const before = await f.registry();
  await assert.rejects(f.api.remove('go@1.24.3'));
  assert.equal(await f.registry(), before);
  f.failures.clear();
  await f.api.remove('go@1.24.3');
  assert.equal(JSON.parse(await f.registry()).tools.go.versions['1.24.3'], undefined);
  f.calls.length = 0;
  await assert.rejects(f.api.remove('go@1.22.1'));
  assert.equal(f.calls.length, 0);
});

test('Given current 缺失和另一个失败工具 When restore Then 仅恢复 current 精确版本且隔离失败', async t => {
  const f = await fixture(t);
  await f.api.install('go@1.23.1');
  await f.api.install('go@1.24.3');
  await f.api.install('python');
  await fs.rm(path.join(f.dataDir, 'installs'), { recursive: true });
  f.calls.length = 0;
  f.failures.add('install go@1.24.3');
  const result = await f.api.restore();
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].tool, 'go');
  assert.equal(result.tools[0].tool, 'python');
  assert.deepEqual(f.calls.filter(c => c.command === '/usr/local/bin/mise' && c.args[0] === 'install').map(c => c.args[1]), ['go@1.24.3', 'python@3.13.2']);
  assert.ok(!f.calls.some(c => c.command === '/usr/local/bin/mise' && c.args[0] === 'latest'));
});

test('Given 登记但目录缺失 When list Then 返回存在状态且不安装、不 probe', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  await fs.rm(f.installPath('go@1.24.3'), { recursive: true });
  f.calls.length = 0;
  const list = await f.api.list();
  assert.equal(list[0].tool, 'go');
  assert.equal(list[0].version, '1.24.3');
  assert.equal(list[0].exists, false);
  assert.equal(list[0].path, f.installPath('go@1.24.3'));
  assert.ok(f.calls.every(c => c.command === '/usr/local/bin/mise' && c.args[0] === 'where'));
});

test('Given 三工具 current 与另一 Java When execution 显式覆盖 Then 环境组合并保持 JAVA_HOME 一致且不执行命令', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  await f.api.install('python');
  await f.api.install('java@21.0.6');
  await f.api.install('java@17.0.12');
  const before = await f.registry();
  f.calls.length = 0;
  const result = await f.api.execution('jdk@21', 'my-task', ['hello']);
  assert.equal(result.command, 'my-task');
  assert.deepEqual(result.args, ['hello']);
  assert.equal(result.env.JAVA_HOME, f.installPath('java@temurin-21.0.6'));
  for (const spec of ['go@1.24.3', 'python@3.13.2', 'java@temurin-21.0.6']) assert.ok(result.env.PATH.split(path.delimiter).includes(path.join(f.installPath(spec), 'bin')));
  assert.ok(!result.env.PATH.includes(path.join(f.installPath('java@temurin-17.0.12'), 'bin')));
  assert.ok(!result.env.PATH.split(path.delimiter).includes('/usr/local/lib/dsh-env/bin'));
  assert.ok(f.calls.every(c => c.command === '/usr/local/bin/mise' && ['where', 'env'].includes(c.args[0])));
  assert.equal(await f.registry(), before);
  await assert.rejects(f.api.execution('go@1.23', 'go'));
});

test('Given 已注册工具丢失 When proxy Then 拒绝系统回退或隐式安装', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  await fs.rm(f.installPath('go@1.24.3'), { recursive: true });
  f.calls.length = 0;
  await assert.rejects(f.api.proxy('go', ['version']));
  assert.ok(!f.calls.some(c => c.command === '/usr/local/bin/mise' && c.args[0] === 'install'));
});

test('Given 无关工具损坏 When 执行完好的工具 Then 保持目标可用且不回退损坏工具', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  await f.api.install('java');
  await fs.rm(f.installPath('go@1.24.3'), { recursive: true });
  const task = await f.api.proxy('java', ['-version']);
  assert.equal(task.command, path.join(f.installPath('java@temurin-21.0.6'), 'bin', 'java'));
  await assert.rejects(f.api.proxy('go', ['version']));
});

test('Given 无登记系统工具与包装 PATH When proxy Then 返回真实系统命令并过滤包装目录', async t => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'system');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'python'), 'system', { mode: 0o755 });
  const original = process.env.PATH;
  process.env.PATH = `/usr/local/lib/dsh-env/bin${path.delimiter}${bin}`;
  t.after(() => process.env.PATH = original);
  const result = await f.api.proxy('python', ['--version']);
  assert.equal(result.command, path.join(bin, 'python'));
  assert.equal(result.env.PATH, bin);
  assert.equal(f.calls.length, 0);
});

test('Given 任意插件、路径或畸形版本 When 操作 Then 在调用 backend 前拒绝', async t => {
  const f = await fixture(t);
  for (const spec of ['node', 'asdf:go@1.2', '../go@1', 'go@latest', 'go@1;id', 'go@/tmp/x', 'go@1..2', 'java@zulu-21', 'java@temurin-../21']) await assert.rejects(f.api.install(spec));
  await assert.rejects(f.api.proxy('bash'));
  assert.equal(f.calls.length, 0);
});

test('Given mise Java 真实 build 版本 When 安装、切换、删除 Then 保留 build 并按语义选择最高', async t => {
  const f = await fixture(t);
  f.latest.set('java@temurin-21', 'temurin-21.0.9+11');
  f.latest.set('java@temurin-21.0.9', 'temurin-21.0.9+11');
  await f.api.install('java@21.0.9');
  assert.equal(JSON.parse(await f.registry()).tools.java.current, 'temurin-21.0.9+11');
  await f.api.install('java');
  await f.api.install('java@temurin-21.0.10+7');
  await f.api.install('java@temurin-21.0.10+9');
  await f.api.use('jdk@21');
  assert.equal(JSON.parse(await f.registry()).tools.java.current, 'temurin-21.0.10+9');
  assert.equal(JSON.parse(await f.registry()).tools.java.versions['temurin-21.0.9+11'].request, 'temurin-21');
  await f.api.remove('java@temurin-21.0.10+7');
  assert.equal(JSON.parse(await f.registry()).tools.java.versions['temurin-21.0.10+7'], undefined);
  for (const invalid of ['java@21+1', 'java@21.0.9+../1', 'java@21.0.9+1+2']) await assert.rejects(f.api.install(invalid));
});

test('Given 范围安装的版本 When 显式精确 upgrade Then 不升级不访问 backend', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  f.latest.set('go@1.24', '1.24.4');
  f.calls.length = 0;
  await f.api.upgrade('go@1.24.3');
  assert.equal(JSON.parse(await f.registry()).tools.go.current, '1.24.3');
  assert.equal(f.calls.length, 0);
});

test('Given 已登记工具 When where 返回目录穿越路径 Then 不 probe、不更新 registry', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  const before = await f.registry();
  f.responses.set('where go@1.24.4', path.join(f.root, 'outside'));
  f.calls.length = 0;
  await assert.rejects(f.api.install('go@1.24.4'));
  assert.equal(await f.registry(), before);
  assert.ok(f.calls.every(c => c.command === '/usr/local/bin/mise'));
});

test('Given latest 返回其他系列或插件 Then 安装拒绝且不创建 registry', async t => {
  const f = await fixture(t);
  for (const response of ['1.25.3', 'asdf:go@1.24.3', '../1.24.3', '1.24']) {
    f.latest.set('go@1.24', response);
    await assert.rejects(f.api.install('go@1.24'));
  }
  await assert.rejects(f.registry(), { code: 'ENOENT' });
  assert.ok(f.calls.every(c => c.args[0] === 'latest'));
});

test('Given 有效 current When proxy gofmt Then 返回绝对已登记命令', async t => {
  const f = await fixture(t);
  await f.api.install('go');
  const result = await f.api.proxy('gofmt', ['-w', 'main.go']);
  assert.equal(result.command, path.join(f.installPath('go@1.24.3'), 'bin', 'gofmt'));
  assert.deepEqual(result.args, ['-w', 'main.go']);
});

test('Given 损坏或恶意 registry When 操作 Then 不信任内容、不调用 backend、不覆盖原文', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, { recursive: true });
  for (const text of ['{broken', JSON.stringify({ schema: 2, tools: {} }), JSON.stringify({ schema: 1, tools: { go: { current: '../../bad', versions: { '../../bad': { request: '1', installedAt: 'now' } } } } })]) {
    await fs.writeFile(path.join(f.root, 'registry.json'), text);
    await assert.rejects(f.api.install('go'));
    assert.equal(await f.registry(), text);
  }
  assert.equal(f.calls.length, 0);
});
