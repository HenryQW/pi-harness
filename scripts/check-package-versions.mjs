import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const revisions = process.argv.slice(2)
if (revisions[0] === '--') revisions.shift()

if (revisions.length !== 0 && revisions.length !== 2) {
  console.error('Usage: node scripts/check-package-versions.mjs [<base-revision> <head-revision>]')
  process.exit(2)
}

const workingTree = revisions.length === 0
const [base, head] = workingTree ? ['origin/main', 'HEAD'] : revisions
let mergeBase
try {
  mergeBase = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim()
} catch (error) {
  if (!workingTree) throw error
  console.error('origin/main is unavailable. Fetch it before running the package version check.')
  process.exit(1)
}

const diffArgs = ['diff', '--name-only', mergeBase]
if (!workingTree) diffArgs.push(head)
diffArgs.push('--')
const changedFiles = execFileSync('git', diffArgs, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)

const workspaceRoots = ['extensions', 'packages']
const packageDirs = workspaceRoots.flatMap(root => readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(path.join(root, entry.name, 'package.json')))
  .map(entry => path.posix.join(root, entry.name)))

const alwaysPublished = /^(?:README(?:\..*)?|LICENSE|LICENCE)(?:\..*)?$/i
const testPath = /^(?:test|tests|__tests__)\//
// dist/** is generated at prepack (untracked); src/** compiles into dist for build packages.
const generated = /^dist\//
const source = /^src\//

function packageJsonAt(commit, manifest) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${commit}:${manifest}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return null
  }
}

function publishedChange(file, packageDir, packageJson) {
  const relative = file.slice(`${packageDir}/`.length)
  if (relative === 'package.json' || alwaysPublished.test(relative)) return true
  // Build config (e.g. tsconfig.build.json) changes published dist output.
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(relative)) return true
  if (testPath.test(relative)) return false
  if (generated.test(relative)) return false
  if (source.test(relative)) return true

  if (!Array.isArray(packageJson.files)) return true
  return packageJson.files.some(entry => relative === entry || relative.startsWith(`${entry}/`))
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseSemver(version) {
  if (!SEMVER.test(version)) return null
  return version.split('.').map(Number)
}

function isUpgrade(previous, current) {
  const prev = parseSemver(previous)
  const curr = parseSemver(current)
  if (!prev || !curr) return false
  for (let i = 0; i < 3; i++) {
    if (curr[i] !== prev[i]) return curr[i] > prev[i]
  }
  return false
}

const failures = []

for (const packageDir of packageDirs) {
  const manifest = `${packageDir}/package.json`
  const current = workingTree
    ? JSON.parse(readFileSync(manifest, 'utf8'))
    : packageJsonAt(head, manifest) ?? JSON.parse(readFileSync(manifest, 'utf8'))
  if (current.private) continue

  const packageChanged = changedFiles.some(file => file.startsWith(`${packageDir}/`))
  if (!packageChanged || !changedFiles.some(file => file.startsWith(`${packageDir}/`) && publishedChange(file, packageDir, current))) continue

  const previous = packageJsonAt(mergeBase, manifest) ?? workspaceRoots
    .map(root => packageJsonAt(mergeBase, path.posix.join(root, path.posix.basename(packageDir), 'package.json')))
    .find(candidate => candidate?.name === current.name)
  if (previous) {
    const prev = parseSemver(previous.version)
    const curr = parseSemver(current.version)
    if (!prev || !curr) {
      failures.push(`${current.name}: invalid semver ${!prev ? previous.version : current.version}`)
    } else if (previous.version === current.version) {
      failures.push(`${current.name}: version remains ${current.version}`)
    } else if (!isUpgrade(previous.version, current.version)) {
      failures.push(`${current.name}: version must increase (was ${previous.version}, now ${current.version})`)
    }
  } else {
    // New package: current version still must be valid semver.
    if (!parseSemver(current.version)) {
      failures.push(`${current.name}: invalid semver ${current.version}`)
    }
  }
}

if (failures.length) {
  console.error('Published package changes need version bumps:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Package version checks passed.')
