import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function releaseFixture(t, dependencyFields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'publish-workspaces-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const write = (path, contents, mode) => {
    const file = join(cwd, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents, { mode })
  }
  write('package.json', JSON.stringify({ private: true }))
  copyFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), join(cwd, 'pnpm-workspace.yaml'))
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
  return {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RELEASE_TEST_PNPM_PATH: process.env.PATH, PATH: `${join(cwd, 'bin')}${delimiter}${process.env.PATH}` },
  }
}

test('publishes prerequisites before consumers and skips private or unchanged packages', t => {
  const script = fileURLToPath(new URL('./publish-workspaces.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], releaseFixture(t))
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.deepEqual(result.stdout.match(/^PUBLISHED .+$/gm), ['PUBLISHED @test/core', 'PUBLISHED @test/consumer'])
})

test('the workspace install gate rejects dependency cycles', t => {
  const fixture = releaseFixture(t, { peerDependencies: { '@test/consumer': '^1.0.0' } })
  const result = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--store-dir', join(fixture.cwd, 'store')], fixture)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 1, result.error?.message ?? output)
  assert.match(output, /ERR_PNPM_DISALLOW_WORKSPACE_CYCLES/)
})
