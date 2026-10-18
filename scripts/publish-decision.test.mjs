import assert from 'node:assert/strict'
import test from 'node:test'
import { publishDecision } from './publish-decision.mjs'

const name = '@test/example'
const remote = version => () => ({ status: 0, stdout: JSON.stringify(version), stderr: '' })

test('E404 permits first publication', () => {
  assert.equal(publishDecision(name, '1.0.0', (command, args) => {
    assert.equal(command, 'npm')
    assert.deepEqual(args, ['view', name, 'version', '--json'])
    return { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: 'npm error code E404' }
  }), 'publish')
})

test('equal versions skip publication', () => {
  assert.equal(publishDecision(name, '1.2.3', remote('1.2.3')), 'skip')
})

test('only greater versions publish, with numeric component order', () => {
  for (const [local, previous] of [['2.0.0', '1.9.9'], ['1.10.0', '1.9.9'], ['1.2.10', '1.2.9']]) {
    assert.equal(publishDecision(name, local, remote(previous)), 'publish')
    assert.throws(() => publishDecision(name, previous, remote(local)), /is lower than npm version/)
  }
})

test('other npm failures retain the npm error', () => {
  for (const code of ['E401', 'EAI_AGAIN']) {
    const stderr = `npm error code ${code}`
    for (const stdout of [JSON.stringify({ error: { code, summary: 'not E404' } }), '']) {
      assert.throws(() => publishDecision(name, '1.0.0', () => ({ status: 1, stdout, stderr })), { message: stderr })
    }
  }
  const error = new Error('spawn npm ENOENT')
  assert.throws(() => publishDecision(name, '1.0.0', () => ({ error })), error)
})

test('invalid local and registry versions cannot publish', () => {
  for (const version of ['1.2.3-beta.1', '1.2.3+build', '01.2.3', '1.2', '1.2.3\n', null, ['1.2.3']]) {
    assert.throws(() => publishDecision(name, version, () => assert.fail('Invalid local version must not query npm')), /plain x.y.z/)
    assert.throws(() => publishDecision(name, '1.2.3', remote(version)), /plain x.y.z/)
  }
  assert.throws(() => publishDecision(name, '1.2.3', () => ({ status: 0, stdout: 'not JSON' })), SyntaxError)
})
