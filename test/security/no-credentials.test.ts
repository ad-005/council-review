/**
 * Non-negotiable: no code path in this package may open, read, copy or log the host's
 * credential store (`~/.pi/agent/auth.json`, which holds live access/refresh tokens), and no
 * credential material may ever reach a log line or run artifact. See "Credential files are
 * never accessed" in openspec/changes/add-council-review/specs/council-review/model-discovery/
 * spec.md.
 *
 * This is enforced two ways:
 *  1. Statically — every file under src/ is scanned for the forbidden strings/patterns. This
 *     must fail loudly the moment any future edit, anywhere in the package, introduces a path
 *     to the credential store.
 *  2. Dynamically — a token-shaped secret is placed in the environment and discovery is run
 *     against a fake host; nothing it prints or returns may contain that secret.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCatalog } from '../../src/providers.js';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'credential file name', pattern: /auth\.json/i },
  { label: 'credential store path segment', pattern: /\.pi[/\\]agent[/\\]auth/i },
  { label: 'print-api-key subcommand', pattern: /print-api-key/i },
  { label: 'print-bearer-token subcommand', pattern: /print-bearer-token/i },
  { label: '--credentials flag', pattern: /--credentials/i },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (extname(entry.name) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('no code path opens the host credential store (static)', () => {
  const files = listSourceFiles(SRC_DIR);

  it('found at least one source file to scan', () => {
    // A guard against this test silently scanning nothing if src/ ever moves.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      it(`${file.replace(SRC_DIR, 'src')} contains no reference to ${label}`, () => {
        const content = readFileSync(file, 'utf8');
        expect(content).not.toMatch(pattern);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Dynamic check: a fake secret placed in the environment must never reach console output, an
// error message, or the returned Catalog — through discovery's normal store and fallback paths.
// ---------------------------------------------------------------------------------------------

const FAKE_SECRET = 'sk-test-FAKE-not-a-real-token-4f8e9c2b1a';

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'check') {
  const providerIdx = args.indexOf('--provider');
  const provider = providerIdx >= 0 ? args[providerIdx + 1] : null;
  process.stdout.write(JSON.stringify({ status: 'ready', provider, authType: 'api_key' }));
  process.exit(0);
}

if (args[0] === '--list-models') {
  const filePath = process.env.FAKE_LIST_MODELS_FILE;
  if (!filePath) { process.exit(1); }
  process.stdout.write(fs.readFileSync(filePath, 'utf8'));
  process.exit(0);
}

process.exit(1);
`;

let workDir: string;
let piBinPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'council-security-test-'));
  piBinPath = join(workDir, 'fake-pi.cjs');
  writeFileSync(piBinPath, FAKE_PI_SCRIPT);
  chmodSync(piBinPath, 0o755);
  process.env.SOME_FOREIGN_TOKEN = FAKE_SECRET;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.SOME_FOREIGN_TOKEN;
  delete process.env.FAKE_LIST_MODELS_FILE;
  vi.restoreAllMocks();
});

describe('a token-shaped environment value never reaches discovery output (dynamic)', () => {
  it('does not leak into stderr warnings or the returned Catalog via the store path', async () => {
    const dir = join(workDir, '.pi', 'agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'models-store.json'),
      JSON.stringify({
        openrouter: {
          models: [
            {
              id: 'anthropic/claude-3-haiku',
              name: 'Anthropic: Claude 3 Haiku',
              provider: 'openrouter',
              reasoning: false,
              cost: { input: 0.25, output: 1.25 },
              contextWindow: 200000,
              maxTokens: 4096,
            },
            // A malformed entry too, to exercise the warning path.
            { name: 'missing id' },
          ],
        },
      }),
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(catalog)).not.toContain(FAKE_SECRET);
  });

  it('does not leak into the returned Catalog via the fallback listing path', async () => {
    process.env.FAKE_LIST_MODELS_FILE = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'fixtures',
      'catalog',
      'list-models-clean.txt',
    );

    const catalog = await loadCatalog({ homeDir: workDir, piBin: piBinPath });
    expect(JSON.stringify(catalog)).not.toContain(FAKE_SECRET);
  });

  it('does not leak into a DiscoveryError message when discovery fails outright', async () => {
    const unavailablePiBin = join(workDir, 'fake-pi-unavailable.cjs');
    writeFileSync(unavailablePiBin, '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(unavailablePiBin, 0o755);

    let caught: unknown;
    try {
      await loadCatalog({ homeDir: workDir, piBin: unavailablePiBin });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).not.toContain(FAKE_SECRET);
  });
});
