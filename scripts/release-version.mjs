/** Parse a stable release version into exact major, minor, and patch components. */
export function parseReleaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null
  return version.split('.').map(BigInt)
}

export function compareReleaseVersions(left, right) {
  const firstChange = left.findIndex((part, index) => part !== right[index])
  if (firstChange === -1) return 0
  return left[firstChange] < right[firstChange] ? -1 : 1
}
