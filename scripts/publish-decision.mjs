import { spawnSync } from 'node:child_process'
import { compareReleaseVersions, parseReleaseVersion } from './release-version.mjs'

function requireVersion(version) {
  const parts = parseReleaseVersion(version)
  if (!parts) throw new Error(`Version must be plain x.y.z: ${JSON.stringify(version)}`)
  return parts
}

export function publishDecision(name, localVersion, run = spawnSync) {
  const local = requireVersion(localVersion)
  const result = run('npm', ['view', name, 'version', '--json'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const failure = new Error(result.stderr || result.stdout || `npm view failed for ${name} (status ${result.status})`)
    let response
    try {
      response = JSON.parse(result.stdout)
    } catch {
      throw failure
    }
    if (response?.error?.code === 'E404') return 'publish'
    throw failure
  }

  const remoteVersion = JSON.parse(result.stdout)
  const order = compareReleaseVersions(local, requireVersion(remoteVersion))
  if (order > 0) return 'publish'
  if (order < 0) throw new Error(`${name}: local version ${localVersion} is lower than npm version ${remoteVersion}`)
  return 'skip'
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/publish-decision.mjs <name> <version>')
    console.log(publishDecision(process.argv[2], process.argv[3]))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
