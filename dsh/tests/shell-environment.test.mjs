import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const script = fileURLToPath(new URL('../dsh-environment.sh', import.meta.url)).replaceAll('\\', '/');

test('用户脚本可重复加载环境，保留原PATH且不启动服务', () => {
  const result = spawnSync(shell, ['-c', 'set -eu; PATH=/custom/bin:/usr/bin:/bin; . "$1"; first=$PATH; . "$1"; test "$PATH" = "$first"; case ":$PATH:" in *:/custom/bin:*) ;; *) exit 3;; esac; case "$PATH" in /usr/local/lib/dsh-env/bin:*) ;; *) exit 4;; esac; printf ready', 'test', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready');
});
