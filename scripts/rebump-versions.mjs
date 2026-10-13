import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Resolves version-only conflicts left by a merge or rebase onto main:
// each conflicted package.json gets main's version plus the branch's bump level.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options })
}

function gitPathExists(name) {
  return existsSync(path.resolve(root, git(['rev-parse', '--git-path', name]).trim()))
}

// Stage numbers for the main and branch sides of the conflict.
let sides
if (gitPathExists('MERGE_HEAD')) sides = { main: 3, branch: 2, checkout: '--theirs' }
else if (gitPathExists('REBASE_HEAD')) sides = { main: 2, branch: 3, checkout: '--ours' }
else {
  console.error('No merge or rebase is in progress. Run this script after a merge or rebase stops on conflicts.')
  process.exit(1)
}

function unmergedPaths() {
  const stages = new Map()
  for (const entry of git(['ls-files', '-u', '-z']).split('\0').filter(Boolean)) {
    const [info, file] = entry.split('\t')
    if (!stages.has(file)) stages.set(file, new Set())
    stages.get(file).add(Number(info.split(' ')[2]))
  }
  return stages
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION_FIELD = /("version"\s*:\s*)"([^"]*)"/
const PLACEHOLDER = '__REBUMP_VERSION__'
const LEVELS = ['major', 'minor', 'patch']

function readStage(file, stage) {
  const text = git(['show', `:${stage}:${file}`])
  const version = JSON.parse(text).version
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`stage ${stage} version ${version} is not plain x.y.z`)
  const match = text.match(VERSION_FIELD)
  if (match?.[2] !== version) throw new Error(`stage ${stage} top-level "version" is not the first "version" field`)
  return { version, text: text.replace(VERSION_FIELD, `$1"${PLACEHOLDER}"`) }
}

function mergeTexts(current, base, other) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rebump-versions-'))
  try {
    const files = [current, base, other].map((text, index) => {
      const file = path.join(dir, String(index))
      writeFileSync(file, text)
      return file
    })
    const result = spawnSync('git', ['merge-file', '-p', ...files], { encoding: 'utf8' })
    // merge-file exits with the conflict count (capped at 127) or a negative value on error.
    if (result.error || result.status > 127) throw new Error(`git merge-file failed: ${result.error ?? result.stderr.trim()}`)
    return result.status === 0 ? result.stdout : null
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

const resolved = []
const left = []
const errors = []

for (const [file, stages] of unmergedPaths()) {
  if (path.posix.basename(file) !== 'package.json') continue
  try {
    for (const stage of [1, 2, 3]) {
      if (!stages.has(stage)) throw new Error(`stage ${stage} is missing (added or deleted on one side)`)
    }
    const base = readStage(file, 1)
    const main = readStage(file, sides.main)
    const branch = readStage(file, sides.branch)

    const baseParts = base.version.split('.').map(Number)
    const branchParts = branch.version.split('.').map(Number)
    const level = baseParts.findIndex((part, index) => part !== branchParts[index])
    if (level === -1) {
      left.push(`${file}: left conflicted (branch did not bump ${base.version})`)
      continue
    }
    if (branchParts[level] < baseParts[level]) throw new Error(`branch version ${branch.version} is lower than base ${base.version}`)

    const nextParts = main.version.split('.').map(Number)
    nextParts[level] += 1
    nextParts.fill(0, level + 1)
    const next = nextParts.join('.')

    const merged = mergeTexts(...(sides.main === 2 ? [main, base, branch] : [branch, base, main]).map(stage => stage.text))
    if (merged === null) {
      left.push(`${file}: left conflicted (fields other than "version" conflict)`)
      continue
    }
    writeFileSync(path.join(root, file), merged.replace(`"${PLACEHOLDER}"`, `"${next}"`))
    git(['add', '--', file])
    resolved.push(`${file}: ${base.version} -> ${branch.version} (${LEVELS[level]}) => ${next}`)
  } catch (error) {
    errors.push(`${file}: ${error.message}`)
  }
}

const LOCKFILE = 'pnpm-lock.yaml'
let remaining = unmergedPaths()
if (remaining.has(LOCKFILE)) {
  if ([...remaining.keys()].some(file => path.posix.basename(file) === 'package.json')) {
    left.push(`${LOCKFILE}: skipped (resolve package.json conflicts first, then run this script again)`)
  } else {
    git(['checkout', sides.checkout, '--', LOCKFILE])
    const install = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: root, stdio: ['ignore', 2, 2] })
    if (install.status === 0) {
      git(['add', '--', LOCKFILE])
      resolved.push(`${LOCKFILE}: regenerated from the main side`)
    } else {
      errors.push(`${LOCKFILE}: pnpm install --lockfile-only --ignore-scripts failed (${install.error?.message ?? `exit ${install.status}`})`)
    }
    remaining = unmergedPaths()
  }
}

for (const line of [...resolved, ...left]) console.log(line)
if (remaining.size) {
  console.log('Remaining unmerged paths:')
  for (const file of remaining.keys()) console.log(`- ${file}`)
} else {
  console.log('No unmerged paths remain.')
}

if (errors.length) {
  console.error('Errors:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
