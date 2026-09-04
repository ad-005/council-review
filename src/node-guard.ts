// Zero imports beyond node:process, so this can run before any other import work at binary
// startup — a broken or ancient runtime must never fail inside a dependency instead of here.
import process from 'node:process';

const MINIMUM_MAJOR_VERSION = 20;

/**
 * Exits the process with code 2 if the running Node version is older than the minimum
 * supported version, printing both the detected and minimum versions.
 *
 * @param version - The version string to check, defaulting to `process.version`. Exposed as a
 *   parameter purely as a test seam.
 */
export function assertNodeVersion(version: string = process.version): void {
  const detected = version.startsWith('v') ? version.slice(1) : version;
  const major = Number.parseInt(detected.split('.')[0] ?? '', 10);

  if (!Number.isFinite(major) || major < MINIMUM_MAJOR_VERSION) {
    process.stderr.write(
      `council-review: unsupported Node.js version "${detected}" detected; ` +
        `Node.js >= ${MINIMUM_MAJOR_VERSION} is required.\n`,
    );
    process.exit(2);
  }
}
