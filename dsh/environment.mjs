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
  if (!shutdownTimer) shutdownTimer = setTimeout(() => {
    stopChildren('SIGKILL');
  }, 5 * 1000);
}

function launch(command, args, options = {}) {
  const ownsGroup = process.platform !== 'win32' && process.env.DSH_ENV_GROUP !== '1';
  const child = spawn(command, args, { stdio: 'inherit', ...options, detached: ownsGroup, env: { ...(options.env || process.env), DSH_ENV_GROUP: '1' } });
  child.ownsGroup = ownsGroup;
  if (ownsGroup && child.pid) groups.add(child.pid);
  children.add(child);
  const done = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); children.delete(child); resolve(1); });
    child.once('exit', (code, signal) => { children.delete(child); resolve(code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1)); });
  });
  return { child, done };
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
  if (noMutation(args)) return launch(`/usr/bin/${binary}`, args).done;
  if (stat(journal)) throw new Error('上次 apt 操作未完成记录；先执行 dsh-env reconcile，再重试');
  const before = snapshot();
  const desired = targets();
  const cancelled = removalIntent(args);
  atomicJson(journal, { container: containerId(), before, targets: desired, cancelled, args, createdAt: new Date().toISOString() });
  const code = await launch(`/usr/bin/${binary}`, [...aptOptions, ...args]).done;
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
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
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
  const toolFailures = [];
  for (const name of Object.keys(toolRules)) {
    try { await restoreTool(name); } catch (error) { toolFailures.push(`${name}: ${error.message}`); }
  }
  atomicJson(`${STORE}/restore/tools.json`, { failures: toolFailures });
  state({ phase: pending.length || toolFailures.length ? 'failed' : 'ready', pending, toolFailures, failed: failed.filter(name => desired.includes(name)) });
  return pending.length || toolFailures.length ? 1 : 0;
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
  if (!stat(`${STORE}/tools/jdk/current`)) return 0;
  const required = ['ca-certificates', 'libc6', 'libgcc-s1', 'libstdc++6', 'zlib1g'];
  const installed = new Set(snapshot().installed.map(name => name.split(':')[0]));
  const missing = required.filter(name => !installed.has(name));
  if (!missing.length) return 0;
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
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

const toolRules = {
  go: { target: '/usr/local/go', executable: 'bin/go', args: ['version'], env: {} },
  jdk: { target: '/opt/java', executable: 'bin/java', args: ['-version'], env: { JAVA_HOME: '/opt/java' } },
};
function toolMapping(name) { return { source: `${STORE}/tools/${name}/current`, target: toolRules[name].target }; }
async function probe(command, args) {
  if (stopping) return 1;
  const task = launch(command, args);
  const timer = setTimeout(() => {
    try { task.child.ownsGroup ? process.kill(-task.child.pid, 'SIGKILL') : task.child.kill('SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }, 30 * 1000);
  try { return await task.done; } finally { clearTimeout(timer); }
}

async function restoreTool(name) {
  const rule = toolRules[name];
  const { source, target } = toolMapping(name);
  if (!stat(source)) return;
  const destination = fs.realpathSync(source);
  if (!within(`${STORE}/tools/${name}/versions`, destination)) throw new Error(`工具链接越界: ${source}`);
  plainParents(target);
  if (stat(target)) {
    if (!stat(target).isSymbolicLink() || fs.readlinkSync(target) !== source) throw new Error(`工具入口冲突: ${target}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
  }
  Object.assign(process.env, rule.env);
  if (!process.env.PATH.split(':').includes(`${target}/bin`)) process.env.PATH = `${process.env.PATH}:${target}/bin`;
  const code = await probe(`${target}/${rule.executable}`, rule.args);
  if (code !== 0) throw new Error(`${name} 无法运行，检查发行架构和系统依赖`);
}

function validateToolTree(directory) {
  const realRoot = fs.realpathSync(directory);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link) || !within(realRoot, fs.realpathSync(file))) throw new Error(`工具含外部链接: ${file}`);
      } else if (entry.isDirectory()) walk(file);
      else if (!entry.isFile()) throw new Error(`工具含特殊文件: ${file}`);
    }
  }
  walk(realRoot);
}
async function installTool(name, directory) {
  const rule = toolRules[name];
  if (!rule || !directory) throw new Error('用法: dsh-env install go|jdk 已解包的发行目录');
  const sourceDirectory = fs.realpathSync(directory);
  if (within(STORE, sourceDirectory)) throw new Error('安装来源不能位于内部持久化目录');
  validateToolTree(sourceDirectory);
  const root = `${STORE}/tools/${name}`;
  fs.mkdirSync(`${root}/versions`, { recursive: true });
  const version = fs.mkdtempSync(`${root}/versions/install-`);
  fs.cpSync(sourceDirectory, version, { recursive: true, verbatimSymlinks: true });
  const code = await probe(`${version}/${rule.executable}`, rule.args);
  if (code !== 0) throw new Error(`发行目录验证失败，保留当前版本；检查 ${version}`);
  const { source, target } = toolMapping(name);
  plainParents(target);
  if (stat(target) && (!stat(target).isSymbolicLink() || fs.readlinkSync(target) !== source)) throw new Error(`工具入口冲突，未覆盖: ${target}`);
  const next = `${root}/next-${process.pid}`;
  fs.symlinkSync(version, next);
  fs.renameSync(next, source);
  await restoreTool(name);
  console.log(`[environment] 已保存 ${name}；旧版本保留在 ${root}/versions`);
}
function removeTool(name) {
  if (!toolRules[name]) throw new Error('用法: dsh-env remove go|jdk');
  const { source, target } = toolMapping(name);
  if (stat(target)?.isSymbolicLink() && fs.readlinkSync(target) === source) fs.unlinkSync(target);
  if (stat(source)?.isSymbolicLink()) fs.unlinkSync(source);
  console.log('[environment] 已取消工具入口，版本文件保留');
}

async function prepare() {
  initialize();
  const file = `${CONFIG}/paths.txt`;
  const mappings = parseMappings(stat(file) ? fs.readFileSync(file, 'utf8') : '');
  for (const mapping of mappings) {
    if (Object.entries(toolRules).some(([name, rule]) => stat(toolMapping(name).source) && (within(rule.target, mapping.target) || within(mapping.target, rule.target)))) throw new Error(`目标与已安装白名单工具冲突: ${mapping.target}`);
    applyMapping(mapping);
  }
  const failures = [];
  for (const name of Object.keys(toolRules)) {
    try { await restoreTool(name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error(error.message); }
  }
  atomicJson(`${STORE}/restore/tools.json`, { failures });
}

async function supervise(command) {
  await prepare();
  if (stopping) return 1;
  state({ phase: 'starting' });
  atomicJson(`${STORE}/restore/after-hook.json`, { phase: 'pending' });
  if (await runHook(`${CONFIG}/before-start.sh`) !== 0) throw new Error('前置脚本失败，停止启动');
  if (stopping) return 1;
  if (command[0] === '/usr/local/bin/dsh-start.sh') {
    if (await launch('/bin/sh', [command[0], '--prepare']).done !== 0) throw new Error('DSH 插件准备失败');
    if (stopping) return 1;
  }
  const dependencyCode = await locked(['tool-dependencies']);
  if (dependencyCode !== 0) console.error('[environment] 白名单依赖恢复失败，服务以降级状态启动');
  if (stopping) return 1;
  for (const name of Object.keys(toolRules)) {
    try { await restoreTool(name); } catch (error) { console.error(error.message); }
  }
  if (stopping) return 1;
  const service = launch(command[0], command.slice(1));
  const spawned = await new Promise(resolve => {
    service.child.once('spawn', () => resolve(true));
    service.child.once('error', () => resolve(false));
  });
  if (!spawned) throw new Error('服务进程创建失败');
  const worker = launch(process.execPath, [fileURLToPath(import.meta.url), 'restore']);
  const after = runHook(`${CONFIG}/after-start.sh`).catch(error => {
    console.error(`[environment] 后置脚本失败: ${error.message}`);
    return 1;
  }).then(code => {
    atomicJson(`${STORE}/restore/after-hook.json`, { phase: code ? 'failed' : 'complete', exitCode: code });
    if (code !== 0) console.error(`[environment] 后置脚本失败: ${code}`);
  });
  const code = await service.done;
  shutdown();
  await Promise.all([worker.done, after]);
  return code;
}

async function main(args) {
  const [command, ...rest] = args;
  switch (command) {
    case 'baseline': atomicJson(`${HERE}/baseline.json`, snapshot().installed); return 0;
    case 'apt': return locked(['apt-locked', ...rest]);
    case 'apt-locked': return aptTransaction(rest[0], rest.slice(1));
    case 'apt-update': return launch('/usr/bin/apt-get', [...aptOptions, 'update']).done;
    case 'restore-one': return restoreOne(rest[0]);
    case 'tool-dependencies': return toolDependencies();
    case 'restore': return restore();
    case 'prepare': await prepare(); return 0;
    case 'start': if (!rest.length) throw new Error('缺少服务命令'); return supervise(rest);
    case 'install': return locked(['install-locked', ...rest]);
    case 'install-locked': await installTool(rest[0], rest[1]); return 0;
    case 'remove': return locked(['remove-locked', ...rest]);
    case 'remove-locked': removeTool(rest[0]); return 0;
    case 'reconcile': return locked(['reconcile-locked']);
    case 'reconcile-locked': reconcile(); return 0;
    case 'status': console.log(JSON.stringify({ apt: readJson(`${STORE}/restore/status.json`, null), tools: readJson(`${STORE}/restore/tools.json`, null), afterHook: readJson(`${STORE}/restore/after-hook.json`, null), interrupted: readJson(journal, null) }, null, 2)); return 0;
    default: throw new Error('用法: dsh-env status | install go|jdk DIRECTORY | remove go|jdk | reconcile');
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
