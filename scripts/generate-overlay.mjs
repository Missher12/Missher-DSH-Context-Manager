/** Generate the same capability-neutral Bundle overlay for every Host version. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULES = [
  ['context-manager', '@missher/dsh-context-manager'],
  ['context-manager-inspector', '@missher/dsh-context-manager/inspector'],
]

export function renderOverlay() {
  return '# Generated neutral Bundle overlay. Host capability detection selects Context only for future Agent bindings.\n'
    + '- insert:\n'
    + MODULES.map(([id, name]) => '    - id: ' + id + '\n      name: ' + JSON.stringify(name) + '\n').join('')
}

export function renderCompatibility(packageJson, currentCompatibility) {
  if (!currentCompatibility || typeof currentCompatibility !== 'object') {
    throw new TypeError('current COMPATIBILITY.json is required so acceptance evidence is preserved')
  }
  return {
    ...currentCompatibility,
    candidatePackageVersion: packageJson.version,
    runtimeDiagnosticVersion: packageJson.version,
    compatibilityRanges: packageJson.peerDependencies,
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const compatibilityUrl = new URL('../COMPATIBILITY.json', import.meta.url)
  const currentCompatibility = JSON.parse(await readFile(compatibilityUrl, 'utf8'))
  await writeFile('cordis.patch.yml', renderOverlay())
  await writeFile('COMPATIBILITY.json', JSON.stringify(renderCompatibility(packageJson, currentCompatibility), null, 2) + '\n')
}
