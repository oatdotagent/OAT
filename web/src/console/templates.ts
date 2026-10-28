/**
 * Starter workflow definitions. They use only capabilities the backend exposes; whether a
 * capability can actually run depends on which providers the server has configured.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
}

export const TEMPLATES: Template[] = [
  {
    id: 'research',
    name: 'Research brief',
    description: 'Web search → summary, with cited URLs traced back to the search results.',
    definition: {
      name: 'Research brief',
      description: 'Search the web, then summarise with citations that must come from the search results.',
      inputSchema: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string', minLength: 2 } },
        additionalProperties: false,
      },
      steps: [
        {
          id: 'search',
          capability: 'web.search',
          input: { query: '{{input.topic}}', count: 5 },
          verification: { criteria: [{ type: 'min_items', path: 'results', min: 1 }] },
        },
        {
          id: 'summary',
          capability: 'llm.generate',
          dependsOn: ['search'],
          input: {
            prompt:
              'Write a short brief on {{input.topic}} using only these search results. Cite the URL of each source you use.\n\n{{steps.search.output.results}}',
          },
          verification: {
            schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
            criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'search' }],
          },
        },
      ],
    },
  },
  {
    id: 'page',
    name: 'Page digest',
    description: 'Extract a public web page, then summarise it in five bullets.',
    definition: {
      name: 'Page digest',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string', format: 'uri' } },
        additionalProperties: false,
      },
      steps: [
        { id: 'extract', capability: 'web.extract', input: { url: '{{input.url}}' } },
        {
          id: 'digest',
          capability: 'llm.generate',
          dependsOn: ['extract'],
          input: { prompt: 'Summarise this page in five bullets:\n\n{{steps.extract.output.content}}' },
          verification: { criteria: [{ type: 'string_length', path: 'text', min: 1 }] },
        },
      ],
    },
  },
  {
    id: 'repo',
    name: 'Repository snapshot',
    description: 'Fetch public GitHub metadata and write a short status note.',
    definition: {
      name: 'Repository snapshot',
      inputSchema: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        additionalProperties: false,
      },
      steps: [
        { id: 'repo', capability: 'github.repo', input: { owner: '{{input.owner}}', repo: '{{input.repo}}' } },
        {
          id: 'note',
          capability: 'llm.generate',
          dependsOn: ['repo'],
          input: { prompt: 'Write a two-sentence status note for this repository:\n\n{{steps.repo.output}}' },
        },
      ],
    },
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'A single search step to start from.',
    definition: {
      name: 'Untitled workflow',
      steps: [{ id: 'step1', capability: 'web.search', input: { query: '{{input.query}}' } }],
    },
  },
];

/** Build a starter execution input from an inputSchema's properties. */
export function sampleInput(inputSchema: unknown): Record<string, unknown> {
  const props = (inputSchema as { properties?: Record<string, { type?: string }> } | undefined)?.properties;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = v.type === 'number' || v.type === 'integer' ? 0 : v.type === 'boolean' ? false : '';
  }
  return out;
}
