import { z } from 'zod';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import { requestJson } from '../http.js';
import type { AdapterResult, FetchFn, InvokeContext, ProviderAdapter } from '../types.js';
import { parseUpstream, unsupported } from './shared.js';

const ID = 'github';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

const repoResponse = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  html_url: z.string(),
  default_branch: z.string(),
  stargazers_count: z.number().int(),
  forks_count: z.number().int(),
  open_issues_count: z.number().int(),
  language: z.string().nullable(),
  archived: z.boolean(),
  pushed_at: z.string().nullable(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
});

/** GitHub REST API — read-only repository metadata. No write operations are exposed. */
export class GitHubAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'GitHub';
  readonly capabilities = ['github.repo'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'GITHUB_TOKEN';
  readonly docsUrl = 'https://docs.github.com/en/rest';
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: { token?: string; fetchImpl?: FetchFn }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.token);
  }

  private headers(): Record<string, string> {
    return { ...HEADERS, authorization: `Bearer ${this.opts.token}` };
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (capability !== 'github.repo') unsupported(ID, capability);
    if (!this.opts.token) throw new ProviderError('not_configured', ID, 'GITHUB_TOKEN is not set');
    const { owner, repo } = input as CapabilityInput<'github.repo'>;
    // owner/repo are regex-validated by the capability schema; encode anyway.
    const raw = await requestJson({
      provider: ID,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      headers: this.headers(),
      fetchImpl: this.fetchImpl,
      ctx,
    });
    const r = parseUpstream(repoResponse, raw, ID);
    return {
      output: {
        fullName: r.full_name,
        description: r.description,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
        stars: r.stargazers_count,
        forks: r.forks_count,
        openIssues: r.open_issues_count,
        language: r.language,
        archived: r.archived,
        pushedAt: r.pushed_at,
        license: r.license?.spdx_id ?? null,
      },
      usage: { requests: 1 },
    };
  }

  /** GET /rate_limit does not count against the primary rate limit. */
  async healthCheck(ctx: InvokeContext): Promise<void> {
    await requestJson({ provider: ID, url: 'https://api.github.com/rate_limit', headers: this.headers(), fetchImpl: this.fetchImpl, ctx });
  }
}
