import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skillName = 'mzzsfy-dsh-help';
const skillFile = fileURLToPath(new URL(`../skills/${skillName}/SKILL.md`, import.meta.url));
const dockerfile = fileURLToPath(new URL('../Dockerfile', import.meta.url));

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'SKILL.md 必须以 YAML frontmatter 开始');
  return match[1];
}

test('内置 skill 的 frontmatter 合法且名称带 mzzsfy 前缀', () => {
  const text = readFileSync(skillFile, 'utf8');
  const header = frontmatter(text);
  const name = header.match(/^name:\s*(\S+)\s*$/m)?.[1];
  const description = header.match(/^description:\s*(.+)$/m)?.[1];
  assert.equal(name, skillName);
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'DSH 要求 kebab-case 名称');
  assert.ok(name.startsWith('mzzsfy-'), '内置 skill 名称需带 mzzsfy 前缀以避免冲突');
  assert.ok(description && description.length >= 20, 'description 是触发依据，不能为空或过短');
  assert.match(description, /dsh/, 'description 必须标明这是 dsh 镜像专用 skill');
});

test('内置 skill 正文保留镜像关键事实', () => {
  const text = readFileSync(skillFile, 'utf8');
  for (const fact of ['dsh-env install', '/usr/local/bin/dsh-environment.sh', '/root/.dsh/container/paths.txt', '/root/.persist']) {
    assert.ok(text.includes(fact), `正文缺少关键事实: ${fact}`);
  }
  assert.ok(text.split('\n').length <= 200, 'skill 正文按需加载，不应超过 200 行');
});

test('Dockerfile 只把 skill 放在镜像层，由启动流程释放', () => {
  const text = readFileSync(dockerfile, 'utf8');
  const copy = text.match(/^COPY\s+skills\s+(\S+)\s*$/m);
  assert.ok(copy, '缺少 skill 目录的 COPY');
  assert.equal(copy[1], '/usr/local/share/dsh/skills');
  assert.doesNotMatch(text, /DSH_BUNDLED_SKILL_DIR/, '不再依赖环境变量');
  const startup = readFileSync(new URL('../environment.mjs', import.meta.url), 'utf8');
  assert.match(startup, /releaseBundledSkills/);
  assert.match(startup, /'\/root\/\.agents\/skills'/);
});
