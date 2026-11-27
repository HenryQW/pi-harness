import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishDecision } from './publish-decision.mjs'

export function releaseWorkspaces() {
  const recordPrefix = 'release-workspace:'
  const output = execFileSync('pnpm', [
    '--recursive', '--sort', '--workspace-concurrency=1',
    '--filter', '{extensions/*}', '--filter', '{packages/*}',
    'exec', 'node', '-p', `${JSON.stringify(recordPrefix)} + JSON.stringify(process.cwd())`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const records = output.split('\n').filter(line => line.startsWith(recordPrefix))
  if (!records.length) throw new Error('No release workspaces found.')

  return records.map(line => {
    const directory = JSON.parse(line.slice(recordPrefix.length))
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return { directory, manifest }
  }).filter(({ manifest }) => !manifest.private)
}

if (import.meta.main) {
  try {
    let published = false
    for (const { directory, manifest: { name, version } } of releaseWorkspaces()) {
      if (publishDecision(name, version) === 'skip') continue
      console.log(`Publishing ${name}@${version}`)
      execFileSync('npm', ['publish'], { cwd: directory, stdio: 'inherit' })
      published = true
    }
    if (!published) console.log('No new package versions.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
