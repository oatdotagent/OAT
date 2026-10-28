// node render.mjs stills <t1,t2,...>  -> PNG stills for review
// node render.mjs video <out.mp4> <audio.wav>  -> frames piped straight into ffmpeg
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DURATION, FPS, H, T, W } from './timeline.mjs';

const require = createRequire('C:/oat/package.json');
const { chromium } = require('playwright-core');
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const [mode, arg1, arg2] = process.argv.slice(2);

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(readFileSync(`${dir}scene.html`, 'utf8'));
await page.evaluate(() => document.fonts.ready);
const frame = async (t) => {
  await page.evaluate(([t, T]) => window.render(t, T), [t, T]);
  return page.screenshot({ type: 'png' });
};

if (mode === 'stills') {
  const { writeFileSync } = await import('node:fs');
  for (const t of arg1.split(',').map(Number)) writeFileSync(`${dir}still-${t.toFixed(1)}.png`, await frame(t));
} else {
  const ff = spawn(ffmpeg, [
    '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-i', arg2,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-tune', 'film',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', arg1,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  const total = Math.round(DURATION * FPS);
  for (let i = 0; i < total; i++) {
    const png = await frame(i / FPS);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log(`frame ${i}/${total}`);
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0) { console.error(err); process.exit(1); }
  console.log('encoded', arg1);
}
await browser.close();
