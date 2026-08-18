import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const [base, head] = process.argv.slice(2)

if (!base || !head) {
  throw new Error('Usage: node scripts/check-package-versions.mjs <base-sha> <head-sha>')
}

const changedFiles = execFileSync('git', ['diff', '--name-only', base, head], {
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean)

const packageDirs = readdirSync('packages', { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.posix.join('packages', entry.name))

const alwaysPublished = /^(?:README(?:\..*)?|LICENSE|LICENCE)(?:\..*)?$/i
const testPath = /^(?:test|tests|__tests__)\//

function packageJsonAt(commit, manifest) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${commit}:${manifest}`], { encoding: 'utf8' }))
  } catch {
    return null
  }
}

function publishedChange(file, packageDir, packageJson) {
  const relative = file.slice(`${packageDir}/`.length)
  if (relative === 'package.json' || alwaysPublished.test(relative)) return true
  if (testPath.test(relative)) return false

  if (!Array.isArray(packageJson.files)) return true
  return packageJson.files.some(entry => relative === entry || relative.startsWith(`${entry}/`))
}

const failures = []

for (const packageDir of packageDirs) {
  const manifest = `${packageDir}/package.json`
  const current = packageJsonAt(head, manifest) ?? JSON.parse(readFileSync(manifest, 'utf8'))
  if (current.private) continue

  const packageChanged = changedFiles.some(file => file.startsWith(`${packageDir}/`))
  if (!packageChanged || !changedFiles.some(file => file.startsWith(`${packageDir}/`) && publishedChange(file, packageDir, current))) continue

  const previous = packageJsonAt(base, manifest)
  if (previous && previous.version === current.version) {
    failures.push(`${current.name}: version remains ${current.version}`)
  }
}

if (failures.length) {
  console.error('Published package changes need version bumps:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Package version checks passed.')
