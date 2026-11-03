import { createApi, ApiError } from '../lib/api';
import { formatUptime } from '../lib/format';
import { initCopyButtons, initMobileNav, initTabs } from '../shared/behaviors';

initMobileNav();
initTabs();
initCopyButtons();
initApiStatus();
initScrollSpy();

/** Live status card: reads the public health/readiness endpoints of the server hosting this page. */
function initApiStatus(): void {
  const card = document.querySelector<HTMLElement>('[data-api-status]');
  if (!card) return;
  const badge = card.querySelector<HTMLElement>('[data-status-badge]')!;
  const text = card.querySelector<HTMLElement>('[data-status-text]')!;
  const uptime = card.querySelector<HTMLElement>('[data-status-uptime]')!;
  const ready = card.querySelector<HTMLElement>('[data-status-ready]')!;
  const refresh = card.querySelector<HTMLButtonElement>('[data-status-refresh]')!;
  const note = card.querySelector<HTMLElement>('[data-status-note]')!;
  const api = createApi({ timeoutMs: 8000 });

  const setBadge = (tone: string, label: string, loading = false) => {
    badge.className = `badge badge--${tone}`;
    badge.replaceChildren();
    if (loading) {
      const s = document.createElement('span');
      s.className = 'spinner spinner--xs';
      s.setAttribute('aria-hidden', 'true');
      badge.append(s);
    } else {
      const d = document.createElement('span');
      d.className = 'dot';
      badge.append(d);
    }
    badge.append(label);
  };

  const check = async () => {
    refresh.disabled = true;
    card.setAttribute('aria-busy', 'true');
    setBadge('neutral', 'Checking…', true);
    text.textContent = 'Contacting the API…';
    try {
      const h = await api.health();
      uptime.textContent = formatUptime(h.data.uptimeSeconds);
      text.textContent = 'API is responding';
      try {
        const r = await api.ready();
        ready.textContent = r.data.status === 'ready' ? 'Ready (database and migrations OK)' : 'Not ready';
        setBadge(r.data.status === 'ready' ? 'ok' : 'warn', r.data.status === 'ready' ? 'Online' : 'Degraded');
      } catch (err) {
        // /health/ready answers 503 with a body when not ready.
        ready.textContent = err instanceof ApiError && err.status === 503 ? 'Not ready' : 'Unknown';
        setBadge('warn', 'Degraded');
      }
    } catch (err) {
      // A static host answers /api with a page instead of JSON: this preview has no backend yet.
      if (err instanceof ApiError && err.code === 'invalid_response') {
        setBadge('neutral', 'Launching soon');
        text.textContent = 'The OAT API is not live yet. Follow @getoatsh for the launch.';
        note.textContent = 'This site is a preview. Live server status will appear here once the API goes live.';
        uptime.textContent = '—';
        ready.textContent = '—';
        return;
      }
      setBadge('err', 'Unreachable');
      text.textContent =
        err instanceof ApiError && err.code !== 'network_error' && err.code !== 'timeout'
          ? `Error: ${err.message}`
          : 'No API at this address. Start the backend with npm run dev.';
      uptime.textContent = '—';
      ready.textContent = '—';
    } finally {
      refresh.disabled = false;
      card.removeAttribute('aria-busy');
    }
  };

  refresh.addEventListener('click', () => void check());
  void check();
}

/** Marks the nav link of the section currently in view with aria-current. */
function initScrollSpy(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav__links a[href^="#"]')];
  const sections = links.map((l) => document.querySelector<HTMLElement>(l.getAttribute('href')!)).filter((s): s is HTMLElement => !!s);
  if (!('IntersectionObserver' in window) || sections.length === 0) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const l of links) {
          if (l.getAttribute('href') === `#${e.target.id}`) l.setAttribute('aria-current', 'true');
          else l.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  sections.forEach((s) => observer.observe(s));
}
