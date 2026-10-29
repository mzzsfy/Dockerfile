import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = '/root';
const STORE = '/root/.persist';
const CONFIG = '/root/.dsh/container';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/;
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const aptEnv = () => ({ ...process.env, PATH: SYSTEM_PATH });
const within = (parent, child) => child === parent || child.startsWith(`${parent}/`);

export function mergeTargets(targets, baseline, before, after, cancelled) {
  const result = new Set(targets);
  for (const name of after.manual) {
    if (after.installed.includes(name) && (!before.manual.includes(name) || !before.installed.includes(name)) && !baseline.includes(name)) result.add(name);
  }
  for (const name of before.installed) {
    if (!after.installed.includes(name) && !(after.incomplete || []).includes(name)) result.delete(name);
  }
  for (const name of cancelled) {
    for (const target of result) {
      if (target === name || (!name.includes(':') && target.split(':')[0] === name)) result.delete(target);
    }
  }
  return [...result].sort();
}

export function removalIntent(args) {
  if (noMutation(args)) return [];
  const commands = ['install', 'remove', 'purge', 'autoremove', 'autopurge'];
  const index = args.findIndex(arg => commands.includes(arg));
  if (index < 0) return [];
  const result = [];
  for (let i = index + 1; i < args.length; i++) {
    const arg = args[i];
    if (['-o', '--option', '-c', '--config-file', '-t', '--target-release'].includes(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    const name = args[index] === 'install' ? (arg.endsWith('-') ? arg.slice(0, -1) : '') : arg;
    if (PACKAGE.test(name)) result.push(name);
  }
  return result;
}

const children = new Set();
const groups = new Set();
let stopping = false;
let shutdownTimer;

function shutdown(signal = 'SIGTERM') {
  stopping = true;
  stopChildren(signal);
  if (process.env.DSH_ENV_GROUP === '1') {
    // 内层先清理自己建立的独立组，转发层不抢先杀死负责清理的子监督器。
    for (const pid of groups) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
    }
  } else if (!shutdownTimer) shutdownTimer = setTimeout(() => {
    stopChildren('SIGKILL');
  }, 5 * 1000);
}

function launch(command, args, options = {}) {
  const { ownGroup = false, ...spawnOptions } = options;
  const ownsGroup = process.platform !== 'win32' && process.env.DSH_MANAGED_GROUP !== '1' && (ownGroup || process.env.DSH_ENV_GROUP !== '1');
  const child = spawn(command, args, { stdio: 'inherit', ...spawnOptions, detached: ownsGroup, env: { ...(options.env || process.env), DSH_ENV_GROUP: '1' } });
  child.ownsGroup = ownsGroup;
  if (ownsGroup && child.pid) groups.add(child.pid);
  children.add(child);
  const done = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); children.delete(child); resolve(1); });
    child.once('exit', (code, signal) => { children.delete(child); resolve(code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1)); });
  });
  return { child, done };
}

export async function runManagedCommand(command, args, options = {}) {
  if (stopping) return { code: 1, stdout: '' };
  const { capture = false, timeoutMs = 0, ...spawnOptions } = options;
  const task = launch(command, args, { ...spawnOptions, ownGroup: true, env: { ...(spawnOptions.env || process.env), DSH_MANAGED_GROUP: '1' }, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  const closed = new Promise(resolve => task.child.once('close', resolve));
  let stdout = '';
  let overflow = false;
  const kill = () => {
    try { task.child.ownsGroup ? process.kill(-task.child.pid, 'SIGKILL') : task.child.kill('SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  };
  if (capture) task.child.stdout.on('data', chunk => {
    if (stdout.length + chunk.length > 4 * 1024 * 1024) { overflow = true; kill(); }
    else stdout += chunk.toString();
  });
  const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
  try {
    const code = await task.done;
    kill();
    await closed;
    if (task.child.ownsGroup) groups.delete(task.child.pid);
    return { code: overflow ? 1 : code, stdout };
  } finally { if (timer) clearTimeout(timer); }
}

function stopChildren(signal = 'SIGTERM') {
  for (const pid of groups) {
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code === 'ESRCH') groups.delete(pid); else console.error(error.message); }
  }
  for (const child of children) {
    if (!child.ownsGroup) child.kill(signal);
  }
}

export async function runHook(file, shell = '/bin/sh') {
  if (!stat(file)) return 0;
  if (!fs.statSync(file).isFile()) throw new Error(`钩子必须是文件: ${file}`);
  console.log(`[environment] 执行 ${file}`);
  return launch(shell, [file]).done;
}

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function plainParents(file) {
  for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if (stat(parent)?.isSymbolicLink()) throw new Error(`父目录不能是符号链接: ${parent}`);
  }
}

export function applyMapping({ source, target }) {
  plainParents(source);
  plainParents(target);
  const sourceStat = stat(source);
  if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) throw new Error(`源不是普通目录: ${source}`);
  const targetStat = stat(target);
  if (targetStat) {
    if (targetStat.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source)) return;
    throw new Error(`目标已存在，保留原内容: ${target}`);
  }
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

export function parseMappings(text) {
  const mappings = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const parts = line.split(':');
    if (parts.length !== 2) throw new Error(`目录格式必须为 源:目标: ${line}`);
    const [source, target] = parts.map(part => part.trim());
    for (const value of [source, target]) {
      if (!value.startsWith('/') || path.posix.normalize(value) !== value || /[\x00-\x1f]/.test(value) || value.endsWith('/')) {
        throw new Error(`需要规范化的绝对路径: ${value}`);
      }
    }
    if (!within(HOME, source) || source === HOME || [CONFIG, STORE].some(p => within(p, source) || within(source, p))) {
      throw new Error(`源目录必须位于 /root 且不能使用配置或恢复状态目录: ${source}`);
    }
    const forbidden = ['/root', '/etc', '/proc', '/sys', '/dev', '/run', '/var', '/bin', '/sbin', '/lib', '/lib64', '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/share', '/usr/local/include'];
    if (target === '/' || target === '/opt' || target === '/usr/local' || forbidden.some(p => within(p, target)) || (within('/usr', target) && !within('/usr/local', target))) {
      throw new Error(`不能映射系统或镜像运行目录: ${target}`);
    }
    return { source, target };
  });
  for (let i = 0; i < mappings.length; i++) {
    for (let j = i + 1; j < mappings.length; j++) {
      if (within(mappings[i].target, mappings[j].target) || within(mappings[j].target, mappings[i].target)) {
        throw new Error(`目标目录重复或重叠: ${mappings[j].target}`);
      }
    }
  }
  return mappings;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}

function snapshot() {
  const installed = [], incomplete = [];
  const manualNames = new Set(output('/usr/bin/apt-mark', ['showmanual']).trim().split(/\s+/));
  const manual = [];
  const rows = output('/usr/bin/dpkg-query', ['-W', '-f=${Package}:${Architecture}\t${db:Status-Status}\n']).trim().split('\n');
  for (const row of rows) {
    const [name, status] = row.split('\t');
    if (!PACKAGE.test(name)) continue;
    if (status === 'installed') installed.push(name);
    else if (!['not-installed', 'config-files'].includes(status)) incomplete.push(name);
    if (manualNames.has(name) || manualNames.has(name.split(':')[0])) manual.push(name);
  }
  return { installed, incomplete, manual };
}

const manifest = `${STORE}/manifests/apt.json`;
const journal = `${STORE}/manifests/inflight.json`;
const aptOptions = ['-o', 'DPkg::Lock::Timeout=120', '-o', `Dir::Cache::archives=${STORE}/apt-cache`, '-o', 'APT::Keep-Downloaded-Packages=true', '-o', 'Binary::apt::APT::Keep-Downloaded-Packages=true'];
function targets() {
  const value = readJson(manifest, []);
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !PACKAGE.test(name))) throw new Error('apt 恢复清单损坏');
  return value;
}
function initialize() {
  for (const dir of [CONFIG, `${STORE}/manifests`, `${STORE}/restore`, `${STORE}/tools`, `${STORE}/apt-cache/partial`]) fs.mkdirSync(dir, { recursive: true });
}
function state(value) {
  atomicJson(`${STORE}/restore/status.json`, { ...value, updatedAt: new Date().toISOString() });
  console.log(`[environment] ${value.phase}${value.error ? `: ${value.error}` : ''}`);
}
function noMutation(args) {
  return args.some(arg => ['--simulate', '--just-print', '--dry-run', '--recon', '--no-act', '--download-only'].includes(arg)
    || /^-[a-zA-Z]+$/.test(arg) && /[sd]/.test(arg.slice(1))
    || /(?:simulate|download-only)=(?:true|yes|1)$/i.test(arg));
}
async function aptTransaction(binary, args) {
  if (!['apt', 'apt-get'].includes(binary)) throw new Error('invalid apt entry');
  initialize();
  if (noMutation(args)) return launch(`/usr/bin/${binary}`, args, { env: aptEnv() }).done;
  if (stat(journal)) throw new Error('上次 apt 操作未完成记录；先执行 dsh-env reconcile，再重试');
  const before = snapshot();
  const desired = targets();
  const cancelled = removalIntent(args);
  atomicJson(journal, { container: containerId(), before, targets: desired, cancelled, args, createdAt: new Date().toISOString() });
  const code = await launch(`/usr/bin/${binary}`, [...aptOptions, ...args], { env: aptEnv() }).done;
  const after = snapshot();
  const baseline = readJson(`${HERE}/baseline.json`, []);
  atomicJson(manifest, mergeTargets(desired, baseline, before, after, code === 0 ? cancelled : []));
  fs.unlinkSync(journal);
  if (code !== 0) console.error(`[environment] apt 退出 ${code}，已保存确认完成的变更`);
  return code;
}

async function locked(args) {
  initialize();
  return launch('/usr/bin/flock', ['--exclusive', '--no-fork', `${STORE}/manifests/operation.lock`, process.execPath, fileURLToPath(import.meta.url), ...args]).done;
}

async function restoreOne(name) {
  if (stat(journal)) throw new Error('存在未完成的用户 apt 事务，暂停恢复；执行 dsh-env reconcile 确认当前状态');
  if (!targets().includes(name)) return 0;
  if (snapshot().installed.includes(name)) return 0;
  const env = { ...aptEnv(), DEBIAN_FRONTEND: 'noninteractive' };
  const repair = await launch('/usr/bin/dpkg', ['--configure', '-a'], { env }).done;
  if (repair !== 0 || stopping) return repair || 1;
  return launch('/usr/bin/apt-get', [...aptOptions, '-y', '--no-remove', 'install', name], { env }).done;
}

async function restore() {
  initialize();
  const failed = [];
  if (stat(journal)) { state({ phase: 'failed', error: '未完成的 apt 事务，需要 dsh-env reconcile' }); return 1; }
  let desired = targets();
  const installed = snapshot().installed;
  const missing = desired.filter(name => !installed.includes(name));
  state({ phase: 'restoring', pending: missing });
  if (missing.length) {
    const updated = await locked(['apt-update']);
    if (updated !== 0) console.error('[environment] 软件源更新失败，继续尝试已有索引和缓存');
  }
  for (const name of missing) {
    if (stopping) return 1;
    state({ phase: 'restoring', current: name, failed });
    const code = await locked(['restore-one', name]);
    if (code !== 0) failed.push(name);
  }
  desired = targets();
  const actual = snapshot().installed;
  const pending = desired.filter(name => !actual.includes(name));
  state({ phase: pending.length ? 'failed' : 'ready', pending, failed: failed.filter(name => desired.includes(name)) });
  return pending.length ? 1 : 0;
}

export function reconcileTargets(desired, baseline, pending, actual, container) {
  const before = pending.container === container ? pending.before : { installed: [], manual: [] };
  return mergeTargets(desired, baseline, before, actual, pending.cancelled);
}

function containerId() {
  const file = '/run/dsh-env-container-id';
  if (!stat(file)) fs.writeFileSync(file, `${Date.now()}-${process.pid}-${Math.random()}`, { flag: 'wx' });
  return fs.readFileSync(file, 'utf8');
}

async function toolDependencies() {
  const registry = readJson(`${STORE}/toolchains/registry.json`, { tools: {} });
  if (!Object.keys(registry.tools || {}).length) return 0;
  if (stat(journal)) throw new Error('apt 事务未完成，暂不补工具依赖');
  const required = ['ca-certificates', 'libc6', 'libgcc-s1', 'libstdc++6', 'zlib1g'];
  const installed = new Set(snapshot().installed.map(name => name.split(':')[0]));
  const missing = required.filter(name => !installed.has(name));
  if (!missing.length) return 0;
  const env = { ...aptEnv(), DEBIAN_FRONTEND: 'noninteractive' };
  await launch('/usr/bin/apt-get', [...aptOptions, 'update'], { env }).done;
  if (stopping) return 1;
  return launch('/usr/bin/apt-get', [...aptOptions, '-y', '--no-remove', 'install', ...missing], { env }).done;
}

function reconcile() {
  const pending = readJson(journal, null);
  if (!pending) return;
  const actual = snapshot();
  if (actual.incomplete.length) throw new Error('dpkg 有未配置的软件，请先 /usr/bin/dpkg --configure -a 后再 reconcile');
  const desired = reconcileTargets(targets(), readJson(`${HERE}/baseline.json`, []), pending, actual, containerId());
  atomicJson(manifest, desired);
  fs.unlinkSync(journal);
  console.log('[environment] 已按当前安装状态及中断前卸载意图核对清单，下次启动重试恢复');
}

async function tools() {
  const { createToolchains } = await import('./toolchains.mjs');
  return createToolchains({ run: runManagedCommand });
}

async function toolsLocked(args) {
  initialize();
  return launch('/usr/bin/flock', ['--exclusive', '--no-fork', `${STORE}/manifests/tools.lock`, process.execPath, fileURLToPath(import.meta.url), 'tools-locked', ...args]).done;
}

async function toolAction(args) {
  const [action, ...rest] = args;
  const manager = await tools();
  if (action === 'restore') {
    atomicJson(`${STORE}/restore/tools.json`, { phase: 'restoring' });
    try {
      const result = await manager.restore();
      atomicJson(`${STORE}/restore/tools.json`, { ...result, phase: result.failures.length ? 'failed' : 'ready' });
      return result.failures.length ? 1 : 0;
    } catch (error) {
      atomicJson(`${STORE}/restore/tools.json`, { phase: 'failed', failures: [error.message] });
      return 1;
    }
  }
  if (!['install', 'upgrade', 'use', 'remove'].includes(action) || rest.length > 1 || (action !== 'upgrade' && rest.length !== 1)) throw new Error('工具命令只接受一个 TOOL[@VERSION]，旧 DIRECTORY 导入接口已移除');
  const result = await manager[action](rest[0]);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function maintainTools() {
  atomicJson(`${STORE}/restore/tools.json`, { phase: 'restoring' });
  const dependencies = await locked(['tool-dependencies']);
  if (dependencies !== 0) console.error('[environment] 工具基础依赖恢复失败，继续检查已有工具');
  if (stopping) return 1;
  return toolsLocked(['restore']);
}

async function prepare() {
  initialize();
  const file = `${CONFIG}/paths.txt`;
  const mappings = parseMappings(stat(file) ? fs.readFileSync(file, 'utf8') : '');
  for (const mapping of mappings) applyMapping(mapping);
  atomicJson(`${STORE}/restore/tools.json`, { phase: 'pending' });
}

export function dshServiceCommand(env = process.env) {
  return ['/usr/local/bin/node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open', '--host', env.DSH_HOST || '0.0.0.0'];
}

async function supervise(command, preparePlugins = false) {
  await prepare();
  if (stopping) return 1;
  state({ phase: 'starting' });
  atomicJson(`${STORE}/restore/after-hook.json`, { phase: 'pending' });
  if (await runHook(`${CONFIG}/before-start.sh`) !== 0) throw new Error('前置脚本失败，停止启动');
  if (stopping) return 1;
  if (preparePlugins) {
    if (await launch('/bin/sh', ['/usr/local/bin/docker-entrypoint.sh', '--prepare']).done !== 0) throw new Error('DSH 插件准备失败');
    if (stopping) return 1;
  }
  const service = launch(command[0], command.slice(1));
  const spawned = await new Promise(resolve => {
    service.child.once('spawn', () => resolve(true));
    service.child.once('error', () => resolve(false));
  });
  if (!spawned) throw new Error('服务进程创建失败');
  const worker = launch(process.execPath, [fileURLToPath(import.meta.url), 'restore']);
  const toolWorker = launch(process.execPath, [fileURLToPath(import.meta.url), 'maintain-tools']);
  const after = runHook(`${CONFIG}/after-start.sh`).catch(error => {
    console.error(`[environment] 后置脚本失败: ${error.message}`);
    return 1;
  }).then(code => {
    atomicJson(`${STORE}/restore/after-hook.json`, { phase: code ? 'failed' : 'complete', exitCode: code });
    if (code !== 0) console.error(`[environment] 后置脚本失败: ${code}`);
  });
  const code = await service.done;
  shutdown();
  await Promise.all([worker.done, toolWorker.done, after]);
  return code;
}

async function main(args) {
  const [command, ...rest] = args;
  switch (command) {
    case 'baseline': atomicJson(`${HERE}/baseline.json`, snapshot().installed); return 0;
    case 'apt': return locked(['apt-locked', ...rest]);
    case 'apt-locked': return aptTransaction(rest[0], rest.slice(1));
    case 'apt-update': return launch('/usr/bin/apt-get', [...aptOptions, 'update'], { env: aptEnv() }).done;
    case 'restore-one': return restoreOne(rest[0]);
    case 'tool-dependencies': return toolDependencies();
    case 'restore': return restore();
    case 'prepare': await prepare(); return 0;
    case 'start-dsh': return supervise(dshServiceCommand(), true);
    case 'start': if (!rest.length) throw new Error('缺少服务命令'); return supervise(rest);
    case 'install': case 'upgrade': case 'use': return toolsLocked([command, ...rest]);
    case 'remove': {
      initialize();
      const code = await launch('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '--no-fork', `${STORE}/manifests/tool-usage.lock`, process.execPath, fileURLToPath(import.meta.url), 'remove-unused', ...rest]).done;
      if (code === 75) console.error('[environment] 工具任务正在运行，暂不能卸载；任务结束后重试');
      return code;
    }
    case 'remove-unused': return toolsLocked(['remove', ...rest]);
    case 'tools-locked': return toolAction(rest);
    case 'maintain-tools': return maintainTools();
    case 'list': if (rest.length) throw new Error('用法: dsh-env list'); console.log(JSON.stringify(await (await tools()).list(), null, 2)); return 0;
    case 'exec': case 'proxy': {
      initialize();
      return launch('/usr/bin/flock', ['--shared', '--no-fork', `${STORE}/manifests/tool-usage.lock`, process.execPath, fileURLToPath(import.meta.url), `${command}-locked`, ...rest]).done;
    }
    case 'exec-locked': {
      if (rest.length < 3 || rest[1] !== '--') throw new Error('用法: dsh-env exec TOOL[@VERSION] -- COMMAND [ARGS...]');
      const task = await (await tools()).execution(rest[0], rest[2], rest.slice(3));
      return (await runManagedCommand(task.command, task.args, { env: task.env })).code;
    }
    case 'proxy-locked': {
      if (!rest.length) throw new Error('缺少工具命令');
      const task = await (await tools()).proxy(rest[0], rest.slice(1));
      return (await runManagedCommand(task.command, task.args, { env: task.env })).code;
    }
    case 'reconcile': return locked(['reconcile-locked']);
    case 'reconcile-locked': reconcile(); return 0;
    case 'status': console.log(JSON.stringify({ apt: readJson(`${STORE}/restore/status.json`, null), tools: readJson(`${STORE}/restore/tools.json`, null), afterHook: readJson(`${STORE}/restore/after-hook.json`, null), interrupted: readJson(journal, null) }, null, 2)); return 0;
    case '--help': case 'help': console.log('dsh-env install TOOL[@VERSION] | upgrade [TOOL] | use TOOL@VERSION | remove TOOL@VERSION | list | exec TOOL[@VERSION] -- COMMAND [ARGS...] | status | reconcile\n白名单: go、java (jdk)、python；重建不自动升级；use不下载；remove拒绝当前默认版本。'); return 0;
    default: throw new Error('未知命令，执行 dsh-env --help 查看用法');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
    shutdown(signal);
    process.exitCode = 128 + os.constants.signals[signal];
  });
  main(process.argv.slice(2)).then(code => { process.exitCode = process.exitCode || code; }).catch(error => {
    console.error(`[environment] ${error.stack || error.message}`);
    process.exitCode = 1;
    if (children.size || groups.size) shutdown();
  });
}
