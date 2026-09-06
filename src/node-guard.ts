// Zero imports beyond node:process, so this can run before any other import work at binary
// startup — a broken or ancient runtime must never fail inside a dependency instead of here.
import process from 'node:process';

const MINIMUM_VERSION = '22.19.0';
const MINIMUM_VERSION_PARTS = MINIMUM_VERSION.split('.').map((part) => Number.parseInt(part, 10));

/**
 * Parses a dotted version string into its numeric [major, minor, patch] components, treating any
 * missing or non-numeric component as 0. Returns `null` if the major component itself can't be
 * parsed as a finite number, since that makes the whole version unusable for comparison.
 */
function parseVersionParts(version: string): [number, number, number] | null {
  const segments = version.split('.');
  const major = Number.parseInt(segments[0] ?? '', 10);

  if (!Number.isFinite(major)) {
    return null;
  }

  const minor = Number.parseInt(segments[1] ?? '', 10);
  const patch = Number.parseInt(segments[2] ?? '', 10);

  return [major, Number.isFinite(minor) ? minor : 0, Number.isFinite(patch) ? patch : 0];
}

/**
 * Exits the process with code 2 if the running Node version is older than the minimum
 * supported version (compared component by component — major, then minor, then patch — not
 * major-only), printing both the detected and minimum versions.
 *
 * @param version - The version string to check, defaulting to `process.version`. Exposed as a
 *   parameter purely as a test seam.
 */
export function assertNodeVersion(version: string = process.version): void {
  const detected = version.startsWith('v') ? version.slice(1) : version;
  const parts = parseVersionParts(detected);

  const isSupported =
    parts !== null &&
    (parts[0] > MINIMUM_VERSION_PARTS[0] ||
      (parts[0] === MINIMUM_VERSION_PARTS[0] &&
        (parts[1] > MINIMUM_VERSION_PARTS[1] ||
          (parts[1] === MINIMUM_VERSION_PARTS[1] && parts[2] >= MINIMUM_VERSION_PARTS[2]))));

  if (!isSupported) {
    process.stderr.write(
      `council-review: unsupported Node.js version "${detected}" detected; ` +
        `Node.js >= ${MINIMUM_VERSION} is required.\n`,
    );
    process.exit(2);
  }
}
