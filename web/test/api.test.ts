import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/lib/api';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('sends the bearer token, never cookies, and unwraps the envelope', async () => {
    const f = fakeFetch(() => json({ data: { userId: 'alice', role: 'user', devBypass: false, permissions: [] }, meta: { requestId: 'r1' } }));
    const api = createApi({ getToken: () => 'tok-1234567890abcdef', fetchImpl: f.fn });
    const res = await api.me();
    expect(res.data.userId).toBe('alice');
    expect(f.calls[0]!.url).toBe('/api/v1/me');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1234567890abcdef');
    expect(f.calls[0]!.init.credentials).toBe('omit');
  });

  it('omits the authorization header when there is no token', async () => {
    const f = fakeFetch(() => json({ data: { status: 'ok', uptimeSeconds: 1 }, meta: { requestId: 'r' } }));
    await createApi({ fetchImpl: f.fn }).health();
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('surfaces the server error envelope as ApiError', async () => {
    const f = fakeFetch(() => json({ error: { code: 'invalid_workflow', message: 'bad', details: [{ path: 'steps', message: 'x' }] }, meta: { requestId: 'req-9' } }, 422));
    const err = await createApi({ fetchImpl: f.fn }).createWorkflow({}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'invalid_workflow', message: 'bad', requestId: 'req-9', details: [{ path: 'steps', message: 'x' }] });
  });

  it('maps network failures and non-JSON responses', async () => {
    const down = createApi({ fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    await expect(down.health()).rejects.toMatchObject({ status: 0, code: 'network_error' });
    const html = createApi({ fetchImpl: fakeFetch(() => new Response('<html>', { status: 502 })).fn });
    await expect(html.health()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('builds query strings and JSON bodies correctly', async () => {
    const f = fakeFetch(() => json({ data: [], meta: { requestId: 'r' } }));
    const api = createApi({ fetchImpl: f.fn });
    await api.listExecutions({ workflowId: 'wf_1', status: '', limit: 5 });
    expect(f.calls[0]!.url).toBe('/api/v1/executions?workflowId=wf_1&limit=5');
    await api.startExecution('wf_1', { topic: 'x' });
    expect(f.calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(f.calls[1]!.init.body as string)).toEqual({ input: { topic: 'x' } });
    await api.validateWorkflow('wf_1');
    expect(JSON.parse(f.calls[2]!.init.body as string)).toEqual({});
  });
});
