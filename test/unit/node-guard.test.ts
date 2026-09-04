import { describe, expect, it, vi, afterEach } from 'vitest';
import { assertNodeVersion } from '../../src/node-guard.js';

describe('assertNodeVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a version at the minimum supported major', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v20.0.0');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('accepts a version above the minimum supported major', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v22.5.1');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects a version older than the minimum, exiting with code 2 and naming both versions', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v18.19.0');

    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(message).toContain('18.19.0');
    expect(message).toContain('20');
  });

  it('defaults to the running process version when none is given', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
