import { describe, expect, it, vi, afterEach } from 'vitest';
import { assertNodeVersion } from '../../src/node-guard.js';

describe('assertNodeVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a version at the minimum supported version (exact boundary)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v22.19.0');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('accepts a patch version above the minimum', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v22.19.1');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a minor version above the minimum', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v22.20.0');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a major version above the minimum', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v23.5.0');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a much later major version', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v24.0.0');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a further future major version', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v26.1.0');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects a patch version just below the minimum', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v22.18.9');

    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(message).toContain('22.18.9');
    expect(message).toContain('22.19.0');
  });

  it('rejects the same major version at minor 0', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v22.0.0');

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('rejects an odd (pre-release-line) major version below the minimum', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v21.7.3');

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('rejects the previous LTS major version entirely', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v20.19.0');

    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(message).toContain('20.19.0');
    expect(message).toContain('22.19.0');
  });

  it('rejects a version older than the minimum, exiting with code 2 and naming both versions', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('v18.19.0');

    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(message).toContain('18.19.0');
    expect(message).toContain('22.19.0');
  });

  it('rejects malformed/unparseable versions', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    assertNodeVersion('not-a-version');

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('treats missing minor/patch components as 0 rather than crashing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion('v22.19');

    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockClear();

    assertNodeVersion('v22');

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('defaults to the running process version when none is given', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertNodeVersion();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
