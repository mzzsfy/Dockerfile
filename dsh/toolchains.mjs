import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_ROOT = '/root/.persist/toolchains';
const WRAPPER_BIN = '/usr/local/lib/dsh-env/bin';
const TOOLS = ['go', 'java', 'python'];
const COMMANDS = { go: 'go', gofmt: 'go', java: 'java', javac: 'java', jar: 'java', javadoc: 'java', jshell: 'java', python: 'python', python3: 'python', pip: 'python', pip3: 'python' };
const PROBES = { go: ['version'], java: ['-version'], python: ['--version'] };
const METADATA_TIMEOUT = 30 * 1000;
const INSTALL_TIMEOUT = 30 * 60 * 1000;
const PROBE_TIMEOUT = 10 * 1000;
const numeric = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numbers = version => version.replace(/^temurin-/, '').replace(/\.LTS$/, '').split(/[.+]/).map(BigInt);
const exact = version => version.replace(/^temurin-/, '').split('+')[0].split('.').length >= 3;
const matches = (version, range) => version === range || (range.startsWith('temurin-') && !range.includes('+') && version.startsWith(`${range}+`)) || (!exact(range) && version.startsWith(`${range}.`));
const compare = (left, right) => {
  const a = numbers(left), b = numbers(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0n) !== (b[i] ?? 0n)) return (a[i] ?? 0n) < (b[i] ?? 0n) ? -1 : 1;
  }
  return 0;
};

function versionFor(tool, value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('版本必须为数字点分');
  const valueNumbers = tool === 'java' ? value.replace(/^temurin-/, '') : value;
  const [base, build, ...extra] = valueNumbers.split('+');
  if (!numeric.test(base) || extra.length || (build !== undefined && (tool !== 'java' || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*(?:\.LTS)?$/.test(build) || base.split('.').length < 3))) throw new Error(`非法版本: ${value}`);
  return tool === 'java' ? `temurin-${valueNumbers}` : valueNumbers;
}

function parse(spec) {
  if (typeof spec !== 'string') throw new Error('需要工具规格，例如 go@1.24');
  const parts = spec.split('@');
  const tool = parts[0] === 'jdk' ? 'java' : parts[0];
  if (!TOOLS.includes(tool) || parts.length > 2) throw new Error(`不支持的工具规格: ${spec}`);
  return { tool, request: parts.length === 2 ? versionFor(tool, parts[1]) : null };
}

function validateRegistry(value) {
  if (!plain(value) || value.schema !== 1 || !plain(value.tools) || Object.keys(value).some(key => !['schema', 'tools'].includes(key))) throw new Error('registry 格式或 schema 无效');
  for (const [tool, record] of Object.entries(value.tools)) {
    if (!TOOLS.includes(tool) || !plain(record) || !plain(record.versions) || Object.keys(record).some(key => !['current', 'versions'].includes(key))) throw new Error('registry 工具记录无效');
    if (versionFor(tool, record.current) !== record.current || !exact(record.current) || !Object.hasOwn(record.versions, record.current)) throw new Error('registry current 无效');
    for (const [version, info] of Object.entries(record.versions)) {
      if (versionFor(tool, version) !== version || !exact(version) || !plain(info) || Object.keys(info).some(key => !['request', 'installedAt'].includes(key))) throw new Error('registry 版本记录无效');
      if (versionFor(tool, info.request) !== info.request || !matches(version, info.request) || typeof info.installedAt !== 'string' || !Number.isFinite(Date.parse(info.installedAt))) throw new Error('registry 版本范围或安装时间无效');
    }
  }
  return value;
}

async function stat(file) {
  try { return await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function noSymlinks(file) {
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`拒绝符号链接路径: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === path.dirname(cursor)) return;
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MISE_/i.test(key) && key.toUpperCase() !== 'PATH'));
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  env.PATH = cleanPath(inheritedPath).join(path.delimiter);
  return env;
}

function cleanPath(value) {
  return value.split(path.delimiter).filter(entry => entry && path.isAbsolute(entry) && path.resolve(entry) !== path.resolve(WRAPPER_BIN));
}

/**
 * spec 为 tool 或 tool@数字点分版本；jdk 等同 java，Java 固定 temurin。
 * 一至两段版本是范围，三段及以上是精确版本；use 范围取已登记的语义最高版本。
 * list 返回平铺记录；upgrade() 返回数组，upgrade(spec) 返回单条记录。
 * mutation/restore 由调用方 flock 串行；execution/proxy 仅构建执行描述。
 */
export function createToolchains({ root = DEFAULT_ROOT, dataDir = '/root/.local/share/mise', run, log = console.log } = {}) {
  if (typeof run !== 'function') throw new Error('需要注入统一进程 runner');
  for (const dir of [root, dataDir]) if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\x00-\x1f]/.test(dir)) throw new Error('工具链目录必须为绝对路径');
  root = path.resolve(root);
  dataDir = path.resolve(dataDir);
  const configDir = path.join(root, 'config');
  const configFile = path.join(configDir, 'config.toml');
  const registryFile = path.join(root, 'registry.json');
  const cacheDir = root === path.resolve(DEFAULT_ROOT) ? '/root/.cache/mise' : path.join(root, 'cache');

  async function registry() {
    await noSymlinks(registryFile);
    try { return validateRegistry(JSON.parse(await fs.readFile(registryFile, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { schema: 1, tools: {} }; throw new Error(`无法读取可信 registry: ${error.message}`, { cause: error }); }
  }

  async function save(value) {
    validateRegistry(value);
    await noSymlinks(registryFile);
    await fs.mkdir(root, { recursive: true });
    const temporary = path.join(root, `.registry-${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, registryFile);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async function isolatedEnv() {
    await noSymlinks(configFile);
    await fs.mkdir(configDir, { recursive: true });
    try { await fs.writeFile(configFile, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await stat(configFile))?.isFile() || (await fs.readFile(configFile, 'utf8')) !== '') throw new Error('隔离 mise config.toml 必须为空文件');
    return { ...cleanEnv(), MISE_DATA_DIR: dataDir, MISE_CACHE_DIR: cacheDir, MISE_CONFIG_DIR: configDir, MISE_GLOBAL_CONFIG_FILE: configFile, MISE_NO_CONFIG: '1', MISE_IGNORED_CONFIG_PATHS: '/', MISE_AUTO_INSTALL: 'false' };
  }

  async function mise(args, timeoutMs = METADATA_TIMEOUT) {
    const result = await run('/usr/local/bin/mise', args, { cwd: configDir, env: await isolatedEnv(), capture: true, timeoutMs });
    if (result?.code !== 0) throw new Error(`mise ${args.join(' ')} 失败 (${result?.code ?? '无退出码'})`);
    return String(result.stdout ?? '').trim();
  }

  async function where(tool, version) {
    const output = await mise(['where', `${tool}@${version}`]);
    if (!path.isAbsolute(output) || /[\x00-\x1f]/.test(output) || !within(path.join(dataDir, 'installs', tool), output) || output === path.join(dataDir, 'installs', tool)) throw new Error(`mise where 返回不可信路径: ${output}`);
    const dir = path.resolve(output);
    if (await stat(dir)) {
      const realData = await fs.realpath(dataDir);
      if (!within(realData, await fs.realpath(dir))) throw new Error(`工具目录逃逸 dataDir: ${dir}`);
    }
    return dir;
  }

  async function executable(dir, command) {
    const file = path.join(dir, 'bin', command);
    if (!(await stat(file))?.isFile()) throw new Error(`工具命令不存在: ${file}`);
    if (!within(await fs.realpath(dir), await fs.realpath(file))) throw new Error(`工具命令逃逸安装目录: ${file}`);
    await fs.access(file, constants.X_OK);
    return file;
  }

  async function probe(tool, version) {
    const dir = await where(tool, version);
    if (!(await stat(dir))?.isDirectory()) throw new Error(`工具安装目录不存在: ${dir}`);
    const command = await executable(dir, tool);
    const result = await run(command, PROBES[tool], { cwd: configDir, env: { ...await isolatedEnv(), ...(tool === 'java' ? { JAVA_HOME: dir } : {}) }, capture: true, timeoutMs: PROBE_TIMEOUT });
    if (result?.code !== 0) throw new Error(`${tool}@${version} probe 失败 (${result?.code})`);
    return dir;
  }

  function record(value, tool, version, extra = {}) {
    return { tool, version, ...value.tools[tool].versions[version], current: value.tools[tool].current === version, ...extra };
  }

  function select(value, { tool, request }) {
    const entry = value.tools[tool];
    if (!entry) throw new Error(`工具尚未登记: ${tool}`);
    if (!request) return entry.current;
    const versions = Object.keys(entry.versions).filter(version => matches(version, request)).sort(compare);
    if (!versions.length) throw new Error(`没有已登记的版本: ${tool}@${request}`);
    const selected = versions.at(-1);
    if (versions.length > 1) log(`[toolchains] ${tool}@${request} 匹配多个版本，选择语义最高版本 ${selected}`);
    return selected;
  }

  async function installInto(value, tool, requested) {
    const range = requested ?? (tool === 'java' ? 'temurin-21' : 'latest');
    const version = versionFor(tool, await mise(['latest', `${tool}@${range}`]));
    if (!exact(version) || (range !== 'latest' && !matches(version, range))) throw new Error(`mise latest 返回不匹配的精确版本: ${version}`);
    const request = range === 'latest' ? version.split('.').slice(0, 2).join('.') : range;
    await mise(['install', `${tool}@${version}`], INSTALL_TIMEOUT);
    const dir = await probe(tool, version);
    value.tools[tool] ??= { current: version, versions: {} };
    value.tools[tool].versions[version] = { request, installedAt: new Date().toISOString() };
    value.tools[tool].current = version;
    await save(value);
    return record(value, tool, version, { path: dir, exists: true });
  }

  async function install(spec) {
    const { tool, request } = parse(spec);
    return installInto(await registry(), tool, request);
  }

  async function upgrade(spec) {
    const input = spec === undefined ? null : parse(spec);
    const value = await registry();
    async function upgradeOne(tool, request) {
      const version = select(value, { tool, request });
      const range = value.tools[tool].versions[version].request;
      if ((request && exact(request)) || exact(range)) return record(value, tool, version);
      return installInto(value, tool, range);
    }
    if (input) return upgradeOne(input.tool, input.request);
    const result = [];
    for (const tool of Object.keys(value.tools)) result.push(await upgradeOne(tool, null));
    return result;
  }

  async function use(spec) {
    const input = parse(spec);
    const value = await registry();
    const version = select(value, input);
    const dir = await probe(input.tool, version);
    value.tools[input.tool].current = version;
    await save(value);
    return record(value, input.tool, version, { path: dir, exists: true });
  }

  async function remove(spec) {
    const input = parse(spec);
    const value = await registry();
    const version = select(value, input);
    if (value.tools[input.tool].current === version) throw new Error('不能删除 current，请先 use 其他版本');
    const removed = record(value, input.tool, version);
    await mise(['uninstall', `${input.tool}@${version}`], INSTALL_TIMEOUT);
    delete value.tools[input.tool].versions[version];
    await save(value);
    return removed;
  }

  async function list() {
    const value = await registry();
    const result = [];
    for (const [tool, entry] of Object.entries(value.tools)) {
      for (const version of Object.keys(entry.versions).sort(compare)) {
        try {
          const dir = await where(tool, version);
          result.push(record(value, tool, version, { path: dir, exists: Boolean((await stat(dir))?.isDirectory()) }));
        } catch (error) { result.push(record(value, tool, version, { path: null, exists: false, error: error.message })); }
      }
    }
    return result;
  }

  async function restore() {
    const value = await registry();
    const result = { failures: [], tools: [] };
    for (const [tool, entry] of Object.entries(value.tools)) {
      const version = entry.current;
      try {
        let dir;
        try { dir = await where(tool, version); }
        catch (error) {
          // where 在版本未安装时会返回非零，只对受控精确版本尝试恢复。
          if (!error.message.startsWith('mise where ')) throw error;
        }
        if (!dir || !(await stat(dir))?.isDirectory()) await mise(['install', `${tool}@${version}`], INSTALL_TIMEOUT);
        dir = await probe(tool, version);
        result.tools.push({ tool, version, path: dir });
      } catch (error) { result.failures.push({ tool, version, error: error.message }); }
    }
    return result;
  }

  async function execution(spec, command, args = [], snapshot) {
    const input = spec == null ? null : parse(spec);
    if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('无效的执行命令或参数');
    const value = snapshot || await registry();
    const selected = Object.fromEntries(Object.entries(value.tools).map(([tool, entry]) => [tool, entry.current]));
    if (input) selected[input.tool] = select(value, input);
    let env = cleanEnv();
    const bins = [], extraPaths = [];
    let unavailable = false;
    for (const [tool, version] of Object.entries(selected)) {
      try {
      const dir = await where(tool, version);
      await executable(dir, tool);
      const exported = JSON.parse(await mise(['env', `${tool}@${version}`, '--json']));
      if (!plain(exported) || Object.entries(exported).some(([key, val]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || typeof val !== 'string' || val.includes('\0'))) throw new Error('mise env 返回无效环境');
      for (const [key, val] of Object.entries(exported)) {
        if (key.toUpperCase() === 'PATH') extraPaths.push(...cleanPath(val));
        else if (!/^MISE_/i.test(key) && key !== 'JAVA_HOME') env[key] = val;
      }
      if (tool === 'java') env.JAVA_HOME = dir;
      bins.push(path.join(dir, 'bin'));
      } catch (error) {
        if (input?.tool === tool) throw error;
        unavailable = true;
        console.error(`[toolchains] ${tool}@${version} 暂不可用: ${error.message}`);
      }
    }
    env.PATH = [...new Set([...bins, ...(unavailable ? [WRAPPER_BIN] : []), ...extraPaths, ...cleanPath(env.PATH)])].join(path.delimiter);
    return { command, args: [...args], env };
  }

  async function proxy(command, args = []) {
    if (!Object.hasOwn(COMMANDS, command)) throw new Error(`不支持的代理命令: ${command}`);
    const tool = COMMANDS[command];
    const value = await registry();
    if (value.tools[tool]) {
      const result = await execution(tool, command, args, value);
      const dir = await where(tool, value.tools[tool].current);
      result.command = await executable(dir, command);
      return result;
    }
    const result = await execution(null, command, args, value);
    for (const dir of cleanPath(cleanEnv().PATH)) {
      const candidate = path.join(dir, command);
      if (!(await stat(candidate))?.isFile()) continue;
      const real = await fs.realpath(candidate);
      if (within(path.resolve(WRAPPER_BIN), real) || real === path.resolve('/usr/local/lib/dsh-env/tool-proxy')) continue;
      try { await fs.access(candidate, constants.X_OK); }
      catch { continue; }
      return { ...result, command: candidate };
    }
    throw new Error(`系统 PATH 中找不到真实命令: ${command}`);
  }

  return { install, upgrade, use, remove, list, restore, execution, proxy };
}
