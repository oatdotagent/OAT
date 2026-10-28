import { z } from 'zod';
import { capabilityNames } from '../providers/capabilities.js';

/**
 * Workflow definitions are declarative DAGs of provider-capability calls. Steps never contain
 * code and the backend never lets a model choose the next action — orchestration here is
 * deterministic coordination, not an agent runtime.
 */

const path = z.string().min(1).max(256);
const jsonSchemaObject = z.record(z.string(), z.unknown());

export const criterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('required'), path, description: z.string().max(300).optional() }),
  z.object({ type: z.literal('min_items'), path, min: z.number().int().min(0), description: z.string().max(300).optional() }),
  z.object({ type: z.literal('max_items'), path, max: z.number().int().min(0), description: z.string().max(300).optional() }),
  z.object({
    type: z.literal('string_length'),
    path,
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    description: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('contains'),
    path,
    value: z.string().min(1).max(500),
    caseSensitive: z.boolean().default(false),
    description: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('not_contains'),
    path,
    value: z.string().min(1).max(500),
    caseSensitive: z.boolean().default(false),
    description: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('equals'),
    path,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    description: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('number_range'),
    path,
    min: z.number().optional(),
    max: z.number().optional(),
    description: z.string().max(300).optional(),
  }),
  z.object({
    // Grounding check: every URL found at `path` must appear in the output of `sourceStep`.
    type: z.literal('urls_in_step'),
    path,
    sourceStep: z.string().min(1).max(64),
    sourcePath: path.default('results[*].url'),
    minUrls: z.number().int().min(0).default(1),
    description: z.string().max(300).optional(),
  }),
]);
export type Criterion = z.infer<typeof criterionSchema>;

export const verificationSpecSchema = z.object({
  schema: jsonSchemaObject.optional(),
  criteria: z.array(criterionSchema).max(50).default([]),
  /** When true, a failed verification fails the step (and dependents). */
  required: z.boolean().default(false),
});
export type VerificationSpec = z.infer<typeof verificationSpecSchema>;

export const stepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'step id must be alphanumeric/underscore, starting with a letter'),
  name: z.string().max(120).optional(),
  capability: z.enum(capabilityNames as [string, ...string[]]),
  provider: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
  input: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()).max(50).default([]),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  continueOnError: z.boolean().default(false),
  verification: verificationSpecSchema.optional(),
});
export type StepDefinition = z.infer<typeof stepSchema>;

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  inputSchema: jsonSchemaObject.optional(),
  maxParallelism: z.number().int().min(1).max(16).default(4),
  steps: z.array(stepSchema).min(1).max(50),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
