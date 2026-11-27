import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function release(t, dependencyFields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'publish-workspaces-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (path, contents, mode) => {
    const file = join(cwd, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents, { mode })
  }
  write('package.json', JSON.stringify({ private: true }))
  write('pnpm-workspace.yaml', 'packages: [extensions/*, packages/*, website]\nlinkWorkspacePackages: true\n')
  const manifests = [
    ['packages/core', { name: '@test/core', ...dependencyFields }],
    ['extensions/consumer', { name: '@test/consumer', dependencies: { '@test/core': '^1.0.0' } }],
    ['extensions/unchanged', { name: '@test/unchanged' }],
    ['packages/private', { name: '@test/private', private: true }],
    ['website', { name: '@test/website' }],
  ]
  for (const [path, manifest] of manifests) {
    write(`${path}/package.json`, JSON.stringify({ version: '1.0.0', ...manifest }))
  }
  write('bin/npm', `#!/usr/bin/env node
const [action, name] = process.argv.slice(2)
if (action === 'view' && ['@test/core', '@test/consumer', '@test/unchanged'].includes(name)) {
  console.log(JSON.stringify(name === '@test/unchanged' ? '1.0.0' : '0.9.0'))
} else if (action === 'publish') {
  console.log('PUBLISHED ' + require(process.cwd() + '/package.json').name)
} else {
  throw new Error('Unexpected npm command: ' + process.argv.slice(2).join(' '))
}
`, 0o755)
  write('bin/pnpm', '#!/bin/sh\nprintf "%s\\n" "Scope: all workspace projects"\nPATH="$RELEASE_TEST_PNPM_PATH" exec pnpm "$@"\n', 0o755)
  return spawnSync(process.execPath, [fileURLToPath(new URL('./publish-workspaces.mjs', import.meta.url))], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RELEASE_TEST_PNPM_PATH: process.env.PATH, PATH: `${join(cwd, 'bin')}${delimiter}${process.env.PATH}` },
  })
}

test('publishes prerequisites before consumers and skips private or unchanged packages', t => {
  const result = release(t)
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.deepEqual(result.stdout.match(/^PUBLISHED .+$/gm), ['PUBLISHED @test/core', 'PUBLISHED @test/consumer'])
})

test('a publish dependency cycle fails before publication', t => {
  const result = release(t, { peerDependencies: { '@test/consumer': '^1.0.0' } })
  assert.equal(result.status, 1, result.stderr || result.error?.message)
  assert.match(result.stderr, /ERR_PNPM_TASK_CYCLE/)
  assert.doesNotMatch(result.stdout, /^PUBLISHED /m)
})
