export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'accent';

const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'ok',
  passed: 'ok',
  healthy: 'ok',
  ready: 'ok',
  running: 'info',
  queued: 'neutral',
  pending: 'neutral',
  unknown: 'neutral',
  disabled: 'neutral',
  skipped: 'neutral',
  degraded: 'warn',
  cancelled: 'warn',
  interrupted: 'warn',
  failed: 'err',
  error: 'err',
  unhealthy: 'err',
};

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

export function humanize(s: string): string {
  const t = s.replace(/[_.]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${s} s`;
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((now - t) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : new Intl.NumberFormat().format(n);
}

/** Costs are estimates from the backend; null means "not reported", never zero. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'Not reported';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

export function shortId(id: string): string {
  const [prefix, rest] = id.split('_');
  return rest ? `${prefix}_${rest.slice(0, 8)}` : id.slice(0, 10);
}

export function prettyJson(value: unknown, maxChars = 20_000): string {
  const s = JSON.stringify(value, null, 2) ?? 'null';
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n… (truncated for display)` : s;
}

/** Parse user-entered JSON with a readable error. */
export function parseJsonInput(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
}
