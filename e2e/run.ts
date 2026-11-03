/**
 * End-to-end check of the built app in a real browser (installed Chrome/Edge via playwright-core).
 *
 *   npm run build && npm run test:e2e
 *
 * Starts dist/server.js on a temp database with MOCK providers (development only), then verifies
 * responsive layout (320px → 1440px), navigation, mobile menu, tabs, copy buttons, the full
 * console flow, role-based UI, CSP cleanliness and touch-target sizes. Screenshots are written to
 * E2E_OUT (default e2e/screenshots).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { hashToken } from '../src/auth/auth.js';

const PORT = Number(process.env.E2E_PORT ?? 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(process.env.E2E_OUT ?? 'e2e/screenshots');
const WIDTHS = [320, 375, 414, 768, 1024, 1440];

const failures: string[] = [];
let passed = 0;
function check(cond: unknown, label: string): void {
  if (cond) passed++;
  else failures.push(label);
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
}

function findBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return found;
}

async function startServer(env: Record<string, string>): Promise<ChildProcess> {
  if (!existsSync('dist/server.js') || !existsSync('web/dist/index.html')) throw new Error('Run `npm run build` first');
  // Isolation: run from an empty temp folder so the developer's .env (real API keys, routing) is never
  // loaded, and drop inherited provider/auth variables. The test server only ever talks to MOCK providers.
  const cwd = mkdtempSync(join(tmpdir(), 'oat-e2e-cwd-'));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|GEMINI_|JINA_|TAVILY_|EXA_|GITHUB_TOKEN|PROVIDER_|AUTH_|ENABLE_MOCK|DATABASE_PATH|WEB_DIST_DIR|PORT|HOST)/.test(k)),
  );
  const child = spawn(process.execPath, [resolve('dist/server.js')], {
    cwd,
    env: { ...inherited, WEB_DIST_DIR: resolve('web/dist'), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('exit', () => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  child.stderr?.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/v1/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('Server did not start');
}

/** Elements whose box extends past the viewport (the usual cause of horizontal scrolling). */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const docOverflow = document.documentElement.scrollWidth - vw;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Content inside intentional horizontal scrollers (code blocks) is fine.
      if (el.closest('pre, .tabs__list')) continue;
      // Stacked tables clip their header row for screen readers; it is never painted.
      if (el.closest('.table--stack thead') && getComputedStyle(el.closest('thead')!).position === 'absolute') continue;
      if (r.right > vw + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ').join('.')} (${Math.round(r.left)}→${Math.round(r.right)})`);
    }
    return { docOverflow, offenders: offenders.slice(0, 5) };
  });
}

function trackErrors(page: Page, bucket: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
  page.on('pageerror', (e) => bucket.push(e.message));
}

async function landingChecks(browser: Browser) {
  console.log('\nLanding page');
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1024, isMobile: width < 768 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    trackErrors(page, errors);
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const o = await overflow(page);
    check(o.docOverflow <= 0 && o.offenders.length === 0, `no horizontal overflow at ${width}px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);
    check(errors.length === 0, `no console/CSP errors at ${width}px${errors.length ? ` — ${errors[0]}` : ''}`);
    if ([320, 768, 1440].includes(width)) await page.screenshot({ path: join(OUT, `landing-${width}.png`), fullPage: true });
    await ctx.close();
  }

  // Mobile menu behaviour
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const toggle = page.locator('[data-nav-toggle]');
  check(await toggle.isVisible(), 'mobile: menu button visible');
  check((await page.locator('.nav__links').isVisible()) === false, 'mobile: desktop links hidden');
  await toggle.click();
  check((await toggle.getAttribute('aria-expanded')) === 'true' && (await page.locator('#mobile-menu').isVisible()), 'mobile: menu opens');
  await page.screenshot({ path: join(OUT, 'landing-375-menu.png') });
  await page.locator('#mobile-menu a[href="#features"]').click();
  await page.waitForTimeout(400);
  check((await toggle.getAttribute('aria-expanded')) === 'false' && !(await page.locator('#mobile-menu').isVisible()), 'mobile: menu closes after choosing a link');
  check(page.url().endsWith('#features'), 'mobile: link navigates to #features');
  // Smooth scrolling takes longer on a taller page, so wait for it to settle rather than a fixed delay.
  const settled = await page
    .waitForFunction(() => (document.querySelector('#features')?.getBoundingClientRect().top ?? 9999) < 200, undefined, { timeout: 5000 })
    .then(() => true, () => false);
  check(settled, 'mobile: features section scrolled into view');
  await toggle.click();
  await page.keyboard.press('Escape');
  check((await toggle.getAttribute('aria-expanded')) === 'false', 'mobile: Escape closes the menu');
  const toggleFocused = await page.evaluate(() => document.activeElement?.hasAttribute('data-nav-toggle'));
  check(toggleFocused, 'mobile: focus returns to the menu button');

  // Touch targets
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('a.btn, button, .mobile-menu a, .site-footer a')]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height < 43.5;
      })
      .map((el) => `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 20)}`),
  );
  check(small.length === 0, `mobile: interactive controls ≥ 44px tall${small.length ? ` — ${small.slice(0, 4).join(', ')}` : ''}`);
  await ctx.close();

  // Desktop: anchors, status, tabs, copy, reduced motion
  const dctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await dctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const d = await dctx.newPage();
  await d.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const anchors = await d.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map((a) => a.getAttribute('href')!).filter((h) => h !== '#' && !document.querySelector(h)));
  check(anchors.length === 0, `every in-page link has a target${anchors.length ? ` — missing ${anchors.join(', ')}` : ''}`);
  const routeLinks = await d.evaluate(() => [...new Set([...document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')].map((a) => a.getAttribute('href')!))]);
  for (const href of routeLinks) {
    const res = await fetch(`${BASE}${href}`);
    check(res.ok, `link ${href} resolves (${res.status})`);
  }
  await d.locator('[data-status-badge]').filter({ hasText: 'Online' }).waitFor({ timeout: 5000 }).catch(() => undefined);
  check((await d.locator('[data-status-badge]').textContent())?.includes('Online'), 'hero shows live API status: Online');
  check((await d.locator('[data-status-uptime]').textContent()) !== '—', 'hero shows real uptime');
  check(await d.locator('.preview').getByText('sample data, not live').isVisible(), 'dashboard preview is labelled as sample data');

  await d.locator('#tab-ts').click();
  check((await d.locator('#panel-ts').isVisible()) && !(await d.locator('#panel-curl').isVisible()), 'tabs: click switches panel');
  await d.locator('#tab-ts').press('ArrowRight');
  check((await d.locator('#tab-json').getAttribute('aria-selected')) === 'true' && (await d.evaluate(() => document.activeElement?.id)) === 'tab-json', 'tabs: arrow key moves selection and focus');
  await d.locator('#panel-json .copy-btn').click();
  const clip = await d.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('"urls_in_step"') && clip.trim().startsWith('{'), 'copy button copies the code sample');
  check((await d.locator('#panel-json [data-copy-label]').textContent()) === 'Copied', 'copy button confirms');
  check((await d.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)) === 'auto', 'reduced motion: smooth scrolling disabled');
  const cta = d.locator('.hero .btn--primary');
  check((await cta.getAttribute('href')) === '#docs', 'hero primary CTA opens the getting started section');
  await d.locator('.hero__install .copy-btn').click();
  check((await d.evaluate(() => navigator.clipboard.readText())) === 'npx getoat', 'hero: copy button copies the install command');
  await d.locator('.site-footer__ca .copy-btn').click();
  check((await d.evaluate(() => navigator.clipboard.readText())) === '0x001b8006f91d3345a9a98d426d84488b917139a0', 'footer: copy button copies the exact contract address');
  await d.locator('.site-footer a[href="/console/"]').click();
  await d.waitForURL(`${BASE}/console/`);
  check(true, 'footer link opens the console');
  await dctx.close();
}

async function consoleChecks(browser: Browser, tokens: { user: string; admin: string }) {
  console.log('\nConsole (mobile, user role)');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 820 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  trackErrors(page, errors);
  // 401 responses during sign-in are expected network errors, not page errors.
  const ignorable = (e: string) => e.includes('401');

  await page.goto(`${BASE}/console/`, { waitUntil: 'networkidle' });
  check(await page.getByRole('heading', { name: 'Connect to your server' }).isVisible(), 'shows the connect screen without a token');
  await page.screenshot({ path: join(OUT, 'console-375-connect.png'), fullPage: true });
  await page.getByLabel('API token').fill('oat_definitely_not_a_valid_token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByText('The server did not accept this token.').waitFor();
  check(true, 'rejects a wrong token with a clear error');
  await page.getByLabel('API token').fill(tokens.user);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  await page.getByText('Mock providers are enabled').waitFor();
  check(true, 'connects with a valid token and warns that mock providers are on');
  check(await page.getByRole('cell', { name: /Mock provider/ }).first().isVisible(), 'overview lists providers from the API');
  let o = await overflow(page);
  check(o.docOverflow <= 0 && o.offenders.length === 0, `overview: no overflow at 375px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);
  await page.screenshot({ path: join(OUT, 'console-375-overview.png'), fullPage: true });

  await page.locator('[data-nav-toggle]').click();
  check(!(await page.locator('#console-menu a[data-section="metrics"]').count()), 'user role: no Metrics link');
  await page.locator('#console-menu a[data-section="workflows"]').click();
  await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
  check(true, 'workflows: empty state');
  await page.getByRole('link', { name: 'Create your first workflow' }).click();
  await page.getByRole('heading', { name: 'New workflow' }).waitFor();
  await page.getByRole('button', { name: 'Validate' }).click();
  await page.getByText('Definition is valid.').waitFor();
  check(await page.getByText('Stage 2').isVisible(), 'editor: server validation shows the execution plan');
  // Invalid JSON is caught locally
  const editor = page.getByLabel('Workflow JSON');
  const good = await editor.inputValue();
  await editor.fill('{ not json');
  await page.getByRole('button', { name: 'Validate' }).click();
  check(await page.getByText(/Invalid JSON/).isVisible(), 'editor: invalid JSON shows an error');
  await editor.fill(good);
  o = await overflow(page);
  check(o.docOverflow <= 0 && o.offenders.length === 0, `editor: no overflow at 375px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);
  await page.screenshot({ path: join(OUT, 'console-375-editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.getByRole('heading', { name: 'Research brief' }).waitFor();
  await page.getByText('All steps can run on this server.').waitFor();
  check(true, 'create: navigates to the workflow detail with readiness');

  const input = page.getByLabel('Execution input (JSON)');
  await input.fill('{ "topic": 5 }');
  await page.getByRole('button', { name: 'Check input' }).click();
  await page.getByText('Input does not match the inputSchema').waitFor();
  check(true, 'run: input is validated against inputSchema');
  await input.fill('{ "topic": "vector databases" }');
  await page.getByRole('button', { name: 'Run workflow' }).click();
  await page.waitForURL(/#\/executions\/ex_/);
  await page.locator('.page-head .badge', { hasText: 'Succeeded' }).waitFor({ timeout: 15000 });
  check(true, 'execution: polls until succeeded');
  check((await page.getByText('MOCK data').count()) > 0, 'execution: mock output is labelled');
  await page.getByRole('button', { name: 'View verification' }).last().click();
  await page.getByText(/NOT been independently verified/).waitFor();
  check(await page.getByText('Citations traced').isVisible(), 'verification: shows checks and honest assessment');
  o = await overflow(page);
  check(o.docOverflow <= 0 && o.offenders.length === 0, `execution: no overflow at 375px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);
  await page.screenshot({ path: join(OUT, 'console-375-execution.png'), fullPage: true });

  await page.locator('[data-nav-toggle]').click();
  await page.locator('#console-menu a[data-section="executions"]').click();
  await page.getByRole('heading', { name: 'Executions' }).waitFor();
  await page.getByLabel('Status').selectOption('failed');
  await page.getByRole('heading', { name: 'No failed executions' }).waitFor();
  check(true, 'executions: status filter with empty state');

  // 320px sanity on the busiest console page
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goBack();
  await page.goto(`${BASE}/console/#/executions`);
  await page.locator('.row-link').first().click();
  await page.locator('.step-card').first().waitFor();
  o = await overflow(page);
  check(o.docOverflow <= 0 && o.offenders.length === 0, `execution: no overflow at 320px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);

  // Edit bumps the version; delete removes the workflow after confirmation.
  await page.goto(`${BASE}/console/#/workflows`);
  await page.locator('.row-link').first().click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  const editJson = page.getByLabel('Workflow JSON');
  await editJson.waitFor();
  const renamed = JSON.parse(await editJson.inputValue());
  renamed.name = 'Research brief v2';
  await editJson.fill(JSON.stringify(renamed, null, 2));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: 'Research brief v2' }).waitFor();
  await page.getByText('as version 2').first().waitFor();
  check(true, 'edit: saving renames the workflow and bumps its version');
  o = await overflow(page);
  check(o.docOverflow <= 0 && o.offenders.length === 0, `workflow detail: no overflow at 320px${o.offenders.length ? ` — ${o.offenders.join(', ')}` : ''}`);
  await page.screenshot({ path: join(OUT, 'console-320-workflow.png'), fullPage: true });
  page.once('dialog', (d) => void d.dismiss());
  await page.getByRole('button', { name: 'Delete' }).click();
  check(await page.getByRole('heading', { name: 'Research brief v2' }).isVisible(), 'delete: cancelling the confirmation keeps the workflow');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByText('No workflows yet').waitFor();
  check(true, 'delete: confirming removes the workflow');

  await page.locator('[data-nav-toggle]').click();
  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await page.getByRole('heading', { name: 'Connect to your server' }).waitFor();
  check(await page.evaluate(() => sessionStorage.getItem('oat.apiToken')) === null, 'sign out clears the stored token');
  const real = errors.filter((e) => !ignorable(e));
  check(real.length === 0, `console: no page/CSP errors${real.length ? ` — ${real[0]}` : ''}`);
  await ctx.close();

  console.log('\nConsole (desktop, admin role)');
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await actx.newPage();
  await a.goto(`${BASE}/console/`);
  await a.getByLabel('API token').fill(tokens.admin);
  await a.getByRole('button', { name: 'Connect' }).click();
  await a.getByRole('heading', { name: 'Overview' }).waitFor();
  check(await a.locator('.nav__links a[data-section="metrics"]').isVisible(), 'admin: Metrics link visible');
  await a.getByRole('button', { name: 'Run active probe' }).click();
  await a.getByRole('heading', { name: 'Probe results' }).waitFor();
  check(await a.getByText('Skipped (not configured)').first().isVisible(), 'admin: probe reports unconfigured providers as skipped');
  await a.screenshot({ path: join(OUT, 'console-1440-overview.png'), fullPage: true });
  await a.locator('.nav__links a[data-section="metrics"]').click();
  await a.getByRole('heading', { name: 'Metrics' }).waitFor();
  await a.getByText('Includes MOCK calls').waitFor();
  check(await a.getByRole('cell', { name: 'web.search' }).first().isVisible(), 'metrics: real recorded provider calls, mock flagged');
  await a.screenshot({ path: join(OUT, 'console-1440-metrics.png'), fullPage: true });
  await a.goto(`${BASE}/console/#/workflows/wf_${'0'.repeat(32)}`);
  await a.getByRole('heading', { name: 'Workflow not found' }).waitFor();
  check(true, 'unknown workflow id shows not-found state');
  await actx.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const user = `oat_${randomBytes(24).toString('base64url')}`;
  const admin = `oat_${randomBytes(24).toString('base64url')}`;
  const dir = mkdtempSync(join(tmpdir(), 'oat-e2e-'));
  const server = await startServer({
    NODE_ENV: 'development',
    PORT: String(PORT),
    DATABASE_PATH: join(dir, 'e2e.db'),
    AUTH_TOKENS: `e2e-user:user:${hashToken(user)},e2e-admin:admin:${hashToken(admin)}`,
    ENABLE_MOCK_PROVIDERS: 'true',
    LOG_LEVEL: 'warn',
    RATE_LIMIT_MAX: '1000',
  });
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    await landingChecks(browser);
    await consoleChecks(browser, { user, admin });
  } catch (err) {
    failures.push(`crashed: ${(err as Error).message.split('\n')[0]}`);
    console.error(err);
  } finally {
    await browser.close();
    // Wait for the server to exit so Windows releases the SQLite file before cleanup.
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve());
      server.kill();
    });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${OUT}`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

void main();
