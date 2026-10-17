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

export function renderCompatibility(packageJson) {
  return {
    schemaVersion: 3,
    candidatePackageVersion: packageJson.version,
    runtimeDiagnosticVersion: packageJson.version,
    bundleMode: 'neutral-runtime-capability',
    presetMode: 'host-declared-provider-with-read-only-fallback',
    candidateStatus: 'Scoped build and typechecks passed; package regression (397 passed, 4 skipped), same-package Loader integration (6/6) and final client UI regression (5/5) are recorded. This isolated candidate is not an accepted Release; natural-Host, upgrade, visual/native UI and real-provider checks remain pending.',
    hostCapability: {
      surface: '@deepseek-ai/dsh-agent-preset-registry.compactionHost',
      version: 1,
      requiredMethods: ['register', 'bindingFor', 'retained'],
      selectionSemantics: ['new-bindings-only', 'future-selection-only'],
      missingCapability: 'Keep Host provider and every user preset unchanged; save Context policy without activating it.',
    },
    overlayContract: {
      presetSnapshots: false,
      disablesBasicProvider: false,
      insertsEngineAtRoot: false,
      runtimeCapabilityDetection: true,
      runtimeCompatibilityIsNotProvenByGeneration: true,
    },
    verification: {
      frozenHostSource: { commit: '0ff7e27023e4791dacef8d55cfb90de962fb2a77', sourceManifestSha256: '43fc7611117b4b2c096bb3170753fbd97ac442d71079d0b1e765c819e88b7737' },
      packageRegression: { total: 401, passed: 397, failed: 0, skipped: 4, note: 'Ran before the final client-only emergency epoch guard.' },
      samePackageLoader: { total: 6, passed: 6, failed: 0, staticClosure: { files: 49, edges: 168, oldCandidateReferences: 0, duplicateHostIdentities: 0, unresolvedImports: 0 } },
      finalClient: { build: 'passed', typecheck: 'passed', uiRegression: { total: 5, passed: 5, failed: 0, environment: 'JSDOM', clientSha256: 'a70bb21f23a2ff3b0a2fad8f617ff8e5e27bb1e6088274da2c133818eafdf638' } },
      pending: ['Independent natural Host runtime checks', 'Package upgrade review', 'Browser visual review and public screenshots', 'Native Electron UI', 'Real provider/model behavior and billing', 'Installation and Release'],
    },
    compatibilityRanges: packageJson.peerDependencies,
    plannedIntegrationTarget: {
      hostCommit: '0ff7e27023e4791dacef8d55cfb90de962fb2a77',
      sourceManifestSha256: '43fc7611117b4b2c096bb3170753fbd97ac442d71079d0b1e765c819e88b7737',
      state: 'same-package Loader integration passed 6/6; independent natural-Host, upgrade and visual/native UI review pending',
    },
    priorRollback: {
      artifactVersion: '0.10.0-local.9',
      artifactPath: 'verification/automatic-compaction-20261014/artifacts-final/missher-dsh-context-manager-0.10.0-local.9.tgz',
      artifactSha256: '670e07978d98ceb0800bee021150487d1ce4c4776f3819de84e24a7d87d9c840',
      role: 'rollback-only; accepted published baseline',
    },
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await writeFile('cordis.patch.yml', renderOverlay())
  await writeFile('COMPATIBILITY.json', JSON.stringify(renderCompatibility(packageJson), null, 2) + '\n')
}
