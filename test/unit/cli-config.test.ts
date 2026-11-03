import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth/auth.js';
import { buildEnv, CliUsageError, configExists, DEFAULT_PORT, ensureToken, isPlausibleKey, parseArgs, readConfig, resolveHome, writeConfig } from '../../src/cli/config.js';
import { loadEnv } from '../../src/config/env.js';

const homes: string[] = [];
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'oat-cli-'));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('starts on the default port and opens the browser by default', () => {
    expect(parseArgs([])).toEqual({ command: 'start', port: DEFAULT_PORT, open: true, mock: false });
  });

  it('reads commands and options', () => {
    expect(parseArgs(['setup']).command).toBe('setup');
    expect(parseArgs(['token']).command).toBe('token');
    expect(parseArgs(['--port', '5000', '--no-open', '--mock'])).toEqual({ command: 'start', port: 5000, open: false, mock: true });
    expect(parseArgs(['--port=5001']).port).toBe(5001);
    expect(parseArgs(['-h']).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });

  it('rejects unknown options and invalid ports', () => {
    expect(() => parseArgs(['--nope'])).toThrow(CliUsageError);
    expect(() => parseArgs(['--port'])).toThrow(CliUsageError);
    expect(() => parseArgs(['--port', '70000'])).toThrow(CliUsageError);
    expect(() => parseArgs(['--port=abc'])).toThrow(CliUsageError);
  });
});

describe('resolveHome', () => {
  it('uses GETOAT_HOME, otherwise a folder in the home directory', () => {
    expect(resolveHome({ GETOAT_HOME: '/data/oat' })).toBe('/data/oat');
    expect(resolveHome({})).toMatch(/\.getoat$/);
  });
});

describe('config file', () => {
  it('round-trips keys and reports whether it exists', () => {
    const home = tempHome();
    expect(configExists(home)).toBe(false);
    expect(readConfig(home)).toEqual({});
    writeConfig(home, { EXA_API_KEY: 'exa-test-key-123' });
    expect(configExists(home)).toBe(true);
    expect(readConfig(home)).toEqual({ EXA_API_KEY: 'exa-test-key-123' });
  });

  it('ignores anything that is not a known provider key', () => {
    const home = tempHome();
    writeConfig(home, {});
    writeFileSync(join(home, 'config.env'), '# comment\nAUTH_DEV_BYPASS=true\nHOST=0.0.0.0\nEXA_API_KEY=exa-test-key-123\nJINA_API_KEY=\n');
    expect(readConfig(home)).toEqual({ EXA_API_KEY: 'exa-test-key-123' });
  });

  it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
    const home = tempHome();
    writeConfig(home, { EXA_API_KEY: 'exa-test-key-123' });
    expect(statSync(join(home, 'config.env')).mode & 0o777).toBe(0o600);
  });

  it('applies the server rule for plausible keys', () => {
    expect(isPlausibleKey('abcd1234')).toBe(true);
    expect(isPlausibleKey('short')).toBe(false);
    expect(isPlausibleKey('has a space')).toBe(false);
  });
});

describe('ensureToken', () => {
  it('creates a token once and then keeps it', () => {
    const home = tempHome();
    const token = ensureToken(home);
    expect(token).toMatch(/^oat_[\w-]{40,}$/);
    expect(ensureToken(home)).toBe(token);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(token);
  });
});

describe('buildEnv', () => {
  const opts = { home: '/h', token: 'oat_test-token-value-0123456789', port: 4310, webDist: '/w', config: {} };

  it('produces an environment the server accepts, bound to loopback and requiring the token', () => {
    const env = loadEnv(buildEnv({ ...opts, mock: false }));
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.AUTH_DEV_BYPASS).toBe(false);
    expect(env.AUTH_TOKENS).toEqual([`local:admin:${hashToken(opts.token)}`]);
    expect(env.ENABLE_MOCK_PROVIDERS).toBe(false);
    expect(env.DATABASE_PATH).toContain('oat.db');
  });

  it('never stores the raw token in the server environment', () => {
    expect(JSON.stringify(buildEnv({ ...opts, mock: false }))).not.toContain(opts.token);
  });

  it('enables sample output only with --mock', () => {
    expect(loadEnv(buildEnv({ ...opts, mock: true })).ENABLE_MOCK_PROVIDERS).toBe(true);
  });

  it('passes saved keys through without letting them override safety settings', () => {
    const env = loadEnv(buildEnv({ ...opts, mock: false, config: { EXA_API_KEY: 'exa-test-key-123', HOST: '0.0.0.0' } }));
    expect(env.EXA_API_KEY).toBe('exa-test-key-123');
    expect(env.HOST).toBe('127.0.0.1');
  });
});
