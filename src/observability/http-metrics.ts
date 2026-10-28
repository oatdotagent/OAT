/**
 * In-process HTTP metrics since start-up (per route + method): counts by status class and
 * latency percentiles over a bounded reservoir. Provider metrics are persisted separately.
 */

const RESERVOIR = 1000;

interface RouteStats {
  count: number;
  status: Record<string, number>;
  latencies: number[];
  next: number;
}

export class HttpMetrics {
  private readonly routes = new Map<string, RouteStats>();
  private readonly startedAt = Date.now();

  observe(method: string, route: string, statusCode: number, durationMs: number): void {
    const key = `${method} ${route}`;
    let s = this.routes.get(key);
    if (!s) {
      s = { count: 0, status: {}, latencies: [], next: 0 };
      this.routes.set(key, s);
    }
    s.count++;
    const cls = `${Math.floor(statusCode / 100)}xx`;
    s.status[cls] = (s.status[cls] ?? 0) + 1;
    if (s.latencies.length < RESERVOIR) s.latencies.push(durationMs);
    else {
      s.latencies[s.next] = durationMs;
      s.next = (s.next + 1) % RESERVOIR;
    }
  }

  snapshot() {
    return {
      since: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      routes: [...this.routes.entries()].map(([route, s]) => {
        const sorted = [...s.latencies].sort((a, b) => a - b);
        const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
        return { route, count: s.count, status: s.status, latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) } };
      }),
    };
  }
}
