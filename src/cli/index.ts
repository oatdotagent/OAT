#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEnv, CliUsageError, configExists, ensureToken, isPlausibleKey, parseArgs, PROVIDER_KEYS, readConfig, resolveHome, writeConfig } from './config.js';

const HELP = `OAT: run AI workflows across providers and verify what comes back.

Usage
  getoat                 Start OAT and open the Console
  getoat setup           Add or change your provider API keys
  getoat token           Print your local access token

Options
  --port <number>        Port to use (default 4310)
  --no-open              Do not open the browser
  --mock                 Use labelled sample output instead of real providers
  -v, --version          Print the version
  -h, --help             Print this help

Your keys and data stay on this computer, in ~/.getoat (or GETOAT_HOME).
`;

/** node:sqlite needs 22.13+, so this runs before the server code is loaded. */
function assertNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`OAT needs Node.js 22.13 or newer. You have ${process.versions.node}.`);
    process.exit(1);
  }
}

/** Reads a line without echoing it, so keys never appear on screen or in terminal history. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function runSetup(home: string): Promise<void> {
  const config = readConfig(home);
  if (!process.stdin.isTTY) {
    console.error('Setup needs an interactive terminal.');
    process.exit(1);
  }
  console.log('Add your provider API keys. Typing is hidden. Press Enter to skip or keep the current value.\n');
  for (const key of PROVIDER_KEYS) {
    const state = config[key.name] ? 'set' : 'not set';
    const value = await askHidden(`${key.label} [${state}]\n  Get a key: ${key.url}\n  Key: `);
    if (!value) continue;
    if (isPlausibleKey(value)) config[key.name] = value;
    else console.log('  That does not look like a key, so it was not saved.');
  }
  writeConfig(home, config);
  console.log(`\nSaved ${Object.keys(config).length} key(s) to your OAT folder: ${home}`);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined); // no browser available: the URL is printed anyway
  child.unref();
}

async function runStart(home: string, port: number, open: boolean, mock: boolean): Promise<void> {
  assertNodeVersion();
  if (!mock && !configExists(home)) {
    if (process.stdin.isTTY) await runSetup(home);
    else writeConfig(home, {});
    console.log('');
  }
  const config = readConfig(home);
  const token = ensureToken(home);
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

  const [{ loadEnv }, { serve }] = await Promise.all([import('../config/env.js'), import('../serve.js')]);
  await serve(loadEnv(buildEnv({ home, token, port, mock, webDist, config })));

  const url = `http://127.0.0.1:${port}/console/`;
  console.log(`OAT is running${mock ? ' with sample output (--mock)' : ''}.\n`);
  console.log(`  Console  ${url}`);
  console.log(`  Token    ${token}`);
  console.log(`  Data     ${home}\n`);
  if (!mock && Object.keys(config).length === 0) console.log('No provider keys yet. Run "getoat setup", or try "getoat --mock" first.\n');
  console.log('Paste the token into the Console to connect. Press Ctrl+C to stop.');
  if (open) openBrowser(url);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const home = resolveHome();
  if (args.command === 'help') console.log(HELP);
  else if (args.command === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(pkg.version);
  } else if (args.command === 'token') console.log(ensureToken(home));
  else if (args.command === 'setup') await runSetup(home);
  else await runStart(home, args.port, args.open, args.mock);
}

main().catch((err: NodeJS.ErrnoException) => {
  if (err instanceof CliUsageError) console.error(`${err.message}\n\n${HELP}`);
  else if (err.code === 'EADDRINUSE') console.error('That port is already in use. Try another one: getoat --port 4311');
  else console.error('OAT could not start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
