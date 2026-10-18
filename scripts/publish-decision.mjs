import { spawnSync } from 'node:child_process'

function parseVersion(version) {
  if (typeof version !== 'string' || /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.[0] !== version) {
    throw new Error(`Version must be plain x.y.z: ${JSON.stringify(version)}`)
  }
  return version.split('.').map(BigInt)
}

export function publishDecision(name, localVersion, run = spawnSync) {
  const local = parseVersion(localVersion)
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
  const remote = parseVersion(remoteVersion)
  for (let i = 0; i < 3; i++) {
    if (local[i] > remote[i]) return 'publish'
    if (local[i] < remote[i]) throw new Error(`${name}: local version ${localVersion} is lower than npm version ${remoteVersion}`)
  }
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
