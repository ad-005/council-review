import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_DEFAULTS,
  ConfigError,
  SUPPORTED_CONFIG_VERSIONS,
  appendIgnore,
  configPath,
  ignorePath,
  loadConfig,
  loadIgnore,
  writeConfig,
  type CouncilConfig,
} from '../../src/config.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-review-config-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRawConfig(value: unknown): void {
  const file = configPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

const validPanel = [
  { provider: 'openrouter', model: 'anthropic/claude-x', thinking: 'high' as const },
  { provider: 'openai-codex', model: 'gpt-x' },
];

describe('configPath / ignorePath', () => {
  it('point at .council/config.json and .council/ignore.json under the project root', () => {
    expect(configPath(root)).toBe(path.join(root, '.council', 'config.json'));
    expect(ignorePath(root)).toBe(path.join(root, '.council', 'ignore.json'));
  });
});

describe('loadConfig: valid document round-trip', () => {
  it('loads a fully specified document unchanged', () => {
    const full: CouncilConfig = {
      version: 1,
      baseBranch: 'develop',
      panel: validPanel,
      defaultThinkingLevel: 'medium',
      modelThinkingLevels: { 'openrouter/anthropic/claude-x': 'high' },
      includeContextFiles: true,
      timeoutSeconds: 120,
      maxOutputTokens: 8000,
      mergeWindow: 5,
      claimSimilarity: 0.75,
      failOn: 'critical',
      snapshot: { include: ['dist/**'] },
      vendorOverrides: { 'openrouter/some-model': 'anthropic' },
      retain: 3,
    };
    writeRawConfig(full);

    const loaded = loadConfig(root);
    expect(loaded).toEqual(full);
  });

  it('round-trips through writeConfig and loadConfig', () => {
    writeConfig(root, { version: 1, baseBranch: 'main', panel: validPanel });
    const loaded = loadConfig(root);
    expect(loaded.version).toBe(1);
    expect(loaded.baseBranch).toBe('main');
    expect(loaded.panel).toEqual(validPanel);
  });
});

describe('loadConfig: default fill-in for every optional key', () => {
  it('fills every documented default when the key is omitted', () => {
    writeRawConfig({ version: 1, panel: validPanel });

    const loaded = loadConfig(root);

    expect(loaded.baseBranch).toBe(CONFIG_DEFAULTS.baseBranch);
    expect(loaded.includeContextFiles).toBe(CONFIG_DEFAULTS.includeContextFiles);
    expect(loaded.timeoutSeconds).toBe(CONFIG_DEFAULTS.timeoutSeconds);
    expect(loaded.maxOutputTokens).toBe(CONFIG_DEFAULTS.maxOutputTokens);
    expect(loaded.mergeWindow).toBe(CONFIG_DEFAULTS.mergeWindow);
    expect(loaded.claimSimilarity).toBe(CONFIG_DEFAULTS.claimSimilarity);
    expect(loaded.failOn).toBe(CONFIG_DEFAULTS.failOn);
    expect(loaded.retain).toBe(CONFIG_DEFAULTS.retain);
  });

  it('leaves keys with no documented default undefined when omitted', () => {
    writeRawConfig({ version: 1, panel: validPanel });
    const loaded = loadConfig(root);

    expect(loaded.defaultThinkingLevel).toBeUndefined();
    expect(loaded.modelThinkingLevels).toBeUndefined();
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.vendorOverrides).toBeUndefined();
  });

  it('preserves an explicitly provided value instead of the default', () => {
    writeRawConfig({ version: 1, panel: validPanel, mergeWindow: 42 });
    expect(loadConfig(root).mergeWindow).toBe(42);
  });
});

describe('loadConfig: rejection paths', () => {
  it('rejects a missing config file, directing the user to init', () => {
    expect(() => loadConfig(root)).toThrow(ConfigError);
    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).exitCode).toBe(2);
      expect((err as ConfigError).message).toMatch(/council-review init/);
    }
  });

  it('rejects unparseable JSON, naming the file and the parse error', () => {
    writeRawConfig('{ this is not json');

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.message).toContain(configPath(root));
    }
  });

  it('rejects a value of the wrong type, reporting the offending key path and reason', () => {
    writeRawConfig({ version: 1, panel: validPanel, claimSimilarity: 'high' });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/claimSimilarity');
      expect(e.message).toContain('/claimSimilarity');
    }
  });

  it('rejects a wrong-typed nested value inside panel entries', () => {
    writeRawConfig({ version: 1, panel: [{ provider: 1, model: 'x' }] });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/panel/0/provider');
    }
  });

  it('rejects an unknown thinking level on defaultThinkingLevel', () => {
    writeRawConfig({ version: 1, panel: validPanel, defaultThinkingLevel: 'ultra' });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/defaultThinkingLevel');
      expect(e.message).toMatch(/unknown thinking level/);
    }
  });

  it('rejects an unknown thinking level inside modelThinkingLevels', () => {
    writeRawConfig({
      version: 1,
      panel: validPanel,
      modelThinkingLevels: { 'openrouter/x': 'ludicrous' },
    });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/modelThinkingLevels/openrouter/x');
    }
  });

  it('rejects an unknown thinking level pinned on a panel entry', () => {
    writeRawConfig({
      version: 1,
      panel: [{ provider: 'openrouter', model: 'x', thinking: 'nope' }],
    });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/panel/0/thinking');
    }
  });

  it('rejects an unrecognised version, stating the supported versions', () => {
    writeRawConfig({ version: 99, panel: validPanel });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/version');
      for (const v of SUPPORTED_CONFIG_VERSIONS) {
        expect(e.message).toContain(String(v));
      }
    }
  });

  it('rejects a missing version the same way as an unrecognised one', () => {
    writeRawConfig({ panel: validPanel });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.exitCode).toBe(2);
      expect(e.keyPath).toBe('/version');
    }
  });

  it('does not best-effort parse the rest of the document when the version is unrecognised', () => {
    // Also has a type error elsewhere; the version problem must win, not the type error.
    writeRawConfig({ version: 99, panel: validPanel, claimSimilarity: 'not a number' });

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).keyPath).toBe('/version');
    }
  });

  it('rejects a top-level document that is not a JSON object', () => {
    writeRawConfig(['not', 'an', 'object']);

    try {
      loadConfig(root);
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).exitCode).toBe(2);
    }
  });
});

describe('writeConfig', () => {
  it('creates .council/config.json when none exists', () => {
    writeConfig(root, { version: 1, baseBranch: 'main', panel: validPanel });

    expect(fs.existsSync(configPath(root))).toBe(true);
    const onDisk = fs.readFileSync(configPath(root), 'utf8');
    expect(onDisk.endsWith('\n')).toBe(true);
    expect(JSON.parse(onDisk)).toEqual({ version: 1, baseBranch: 'main', panel: validPanel });
  });

  it('writes pretty-printed JSON', () => {
    writeConfig(root, { version: 1, panel: [] });
    const onDisk = fs.readFileSync(configPath(root), 'utf8');
    expect(onDisk).toContain('\n  "version": 1');
  });

  it('preserves unrelated keys on rewrite, including keys the schema does not know about', () => {
    writeRawConfig({
      version: 1,
      baseBranch: 'main',
      panel: validPanel,
      failOn: 'high',
      somethingFutureVersionsWillUnderstand: { nested: true },
    });

    writeConfig(root, { baseBranch: 'develop' });

    const onDisk = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
    expect(onDisk.baseBranch).toBe('develop');
    expect(onDisk.panel).toEqual(validPanel);
    expect(onDisk.failOn).toBe('high');
    expect(onDisk.somethingFutureVersionsWillUnderstand).toEqual({ nested: true });
  });

  it('replaces a key wholesale rather than deep-merging it', () => {
    writeRawConfig({ version: 1, panel: validPanel, snapshot: { include: ['a/**', 'b/**'] } });

    writeConfig(root, { snapshot: { include: ['c/**'] } });

    const loaded = loadConfig(root);
    expect(loaded.snapshot).toEqual({ include: ['c/**'] });
  });
});

describe('ignore file: load', () => {
  it('returns an empty suppression list when no file exists', () => {
    const ignore = loadIgnore(root);
    expect(ignore.entries).toEqual([]);
  });

  it('rejects malformed ignore JSON', () => {
    const file = ignorePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');

    expect(() => loadIgnore(root)).toThrow(ConfigError);
  });

  it('rejects an ignore file whose entries are the wrong shape', () => {
    const file = ignorePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ fingerprint: 123 }] }), 'utf8');

    try {
      loadIgnore(root);
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).exitCode).toBe(2);
      expect((err as ConfigError).keyPath).toBe('/entries/0/fingerprint');
    }
  });
});

describe('appendIgnore: idempotence', () => {
  it('appends a new fingerprint with a reason', () => {
    appendIgnore(root, { fingerprint: 'abc123', reason: 'false positive' });

    const ignore = loadIgnore(root);
    expect(ignore.entries).toHaveLength(1);
    expect(ignore.entries[0].fingerprint).toBe('abc123');
    expect(ignore.entries[0].reason).toBe('false positive');
    expect(typeof ignore.entries[0].addedAt).toBe('string');
  });

  it('leaves exactly one entry when the same fingerprint is appended twice', () => {
    appendIgnore(root, { fingerprint: 'abc123', reason: 'first reason' });
    appendIgnore(root, { fingerprint: 'abc123', reason: 'second reason' });

    const ignore = loadIgnore(root);
    expect(ignore.entries).toHaveLength(1);
    expect(ignore.entries[0].reason).toBe('first reason');
  });

  it('succeeds (does not throw) when appending an already-present fingerprint', () => {
    appendIgnore(root, { fingerprint: 'dup' });
    expect(() => appendIgnore(root, { fingerprint: 'dup' })).not.toThrow();
  });

  it('accumulates distinct fingerprints', () => {
    appendIgnore(root, { fingerprint: 'one' });
    appendIgnore(root, { fingerprint: 'two' });

    const ignore = loadIgnore(root);
    expect(ignore.entries.map((e) => e.fingerprint).sort()).toEqual(['one', 'two']);
  });

  it('writes valid JSON with a trailing newline', () => {
    appendIgnore(root, { fingerprint: 'abc' });
    const onDisk = fs.readFileSync(ignorePath(root), 'utf8');
    expect(onDisk.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(onDisk)).not.toThrow();
  });
});

describe('init preserves suppressions (config.ts half of the scenario)', () => {
  it('writeConfig does not disturb an existing ignore.json', () => {
    appendIgnore(root, { fingerprint: 'keep-me', reason: 'still valid' });
    writeConfig(root, { version: 1, baseBranch: 'main', panel: validPanel });

    const ignore = loadIgnore(root);
    expect(ignore.entries).toHaveLength(1);
    expect(ignore.entries[0].fingerprint).toBe('keep-me');
  });
});
