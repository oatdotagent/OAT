import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hashToken } from '../auth/auth.js';

/** Provider keys the CLI stores for the user. They stay in the user's home folder and are never printed. */
export const PROVIDER_KEYS = [
  { name: 'GEMINI_API_KEY', label: 'Google Gemini (AI text)', url: 'https://aistudio.google.com/apikey' },
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude (AI text)', url: 'https://console.anthropic.com' },
  { name: 'TAVILY_API_KEY', label: 'Tavily (web search)', url: 'https://app.tavily.com' },
  { name: 'EXA_API_KEY', label: 'Exa (web search)', url: 'https://exa.ai' },
  { name: 'JINA_API_KEY', label: 'Jina (page reading, embeddings)', url: 'https://jina.ai' },
  { name: 'GITHUB_TOKEN', label: 'GitHub (repository data)', url: 'https://github.com/settings/tokens' },
] as const;

export const DEFAULT_PORT = 4310;

export type Command = 'start' | 'setup' | 'token' | 'help' | 'version';
export interface CliArgs {
  command: Command;
  port: number;
  open: boolean;
  mock: boolean;
}

export class CliUsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'start', port: DEFAULT_PORT, open: true, mock: false };
  let commandSeen = false;
  const setPort = (value: string | undefined) => {
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new CliUsageError('--port needs a number from 1 to 65535');
    args.port = Number(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') args.command = 'help';
    else if (arg === '-v' || arg === '--version') args.command = 'version';
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--mock') args.mock = true;
    else if (arg === '--port') setPort(argv[++i]);
    else if (arg.startsWith('--port=')) setPort(arg.slice('--port='.length));
    else if (['start', 'setup', 'token'].includes(arg) && !commandSeen) {
      commandSeen = true;
      if (args.command === 'start') args.command = arg as Command;
    } else throw new CliUsageError(`unknown option "${arg.split('=')[0]}"`);
  }
  return args;
}

/** Data folder. Separate from any server checkout, so `getoat` never reads a project's .env. */
export function resolveHome(source: Record<string, string | undefined> = process.env): string {
  return source.GETOAT_HOME?.trim() || join(homedir(), '.getoat');
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

const configPath = (home: string) => join(home, 'config.env');

export function configExists(home: string): boolean {
  return existsSync(configPath(home));
}

/** Reads only known provider keys, so nothing else in the file can change how the server runs. */
export function readConfig(home: string): Record<string, string> {
  if (!configExists(home)) return {};
  const known = new Set<string>(PROVIDER_KEYS.map((k) => k.name));
  const config: Record<string, string> = {};
  for (const line of readFileSync(configPath(home), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && known.has(m[1]!) && m[2]!.trim()) config[m[1]!] = m[2]!.trim();
  }
  return config;
}

export function writeConfig(home: string, config: Record<string, string>): void {
  ensureHome(home);
  const body = PROVIDER_KEYS.filter((k) => config[k.name]).map((k) => `${k.name}=${config[k.name]}\n`).join('');
  const file = configPath(home);
  writeFileSync(file, `# OAT provider keys. Keep this file private.\n${body}`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Same rule the server applies to credentials. */
export function isPlausibleKey(value: string): boolean {
  return value.length >= 8 && value.length <= 512 && /^\S+$/.test(value);
}

/** Returns the local access token, creating it on first use. */
export function ensureToken(home: string): string {
  ensureHome(home);
  const file = join(home, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = `oat_${randomBytes(32).toString('base64url')}`;
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return token;
}

/**
 * Builds the server environment explicitly instead of inheriting the shell's, so stray variables cannot
 * change behaviour. Binds to loopback only. NODE_ENV stays "development" because the production CSP
 * forces upgrade-insecure-requests, which does not suit a page served over http://127.0.0.1.
 */
export function buildEnv(opts: { home: string; token: string; port: number; mock: boolean; webDist: string; config: Record<string, string> }): Record<string, string> {
  return {
    ...opts.config,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(opts.port),
    LOG_LEVEL: 'warn',
    DATABASE_PATH: join(opts.home, 'oat.db'),
    SERVE_WEB: 'true',
    WEB_DIST_DIR: opts.webDist,
    AUTH_TOKENS: `local:admin:${hashToken(opts.token)}`,
    AUTH_DEV_BYPASS: 'false',
    PROVIDER_FALLBACK_ENABLED: 'true',
    ENABLE_MOCK_PROVIDERS: opts.mock ? 'true' : 'false',
  };
}
