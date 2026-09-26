import { z } from 'zod';

export const uuidSchema = z.string().uuid();
const categorySchema = z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/);
/** Monetary values cross the API as unsigned integer atomic units.  USDC has
 * six decimals; legacy SUI rows are still returned with their original
 * decimals and are never writable through the new task path. */
const amountAtomicSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine((value) => BigInt(value) <= 9_000_000_000_000_000_000n, 'Amount exceeds the supported range');
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const deadlineSchema = z.string().datetime({ offset: true });

export const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(4000),
  category: categorySchema,
  area: z.string().trim().min(1).max(120),
  rubric: z.array(z.string().trim().min(1).max(240)).min(1).max(12),
  amountAtomic: amountAtomicSchema,
  reviewWindowMs: z.number().int().min(0).max(2_592_000_000).optional(),
  rejectSplitBps: z.number().int().min(0).max(10_000).optional(),
  deadline: deadlineSchema,
}).strict();

export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start_worker'), displayName: z.string().trim().min(1).max(80), category: categorySchema, area: z.string().trim().min(1).max(100), skills: z.array(z.string().trim().min(1).max(40)).max(12).default([]) }).strict(),
  z.object({ action: z.literal('start_wallet_challenge'), purpose: z.enum(['worker','owner','recover_worker','recover_owner']), address: addressSchema }).strict(),
  z.object({ action: z.literal('complete_wallet_challenge'), challengeId: uuidSchema, signature: z.string().min(20).max(4096) }).strict(),
  z.object({ action: z.literal('start_worker_verification') }).strict(),
  z.object({ action: z.literal('complete_worker_verification'), challengeId: uuidSchema, idkitResult: z.unknown() }).strict(),
  z.object({ action: z.literal('begin_owner_login') }).strict(),
  z.object({ action: z.literal('begin_owner_authorization'), approvalId: uuidSchema }).strict(),
  z.object({
    action: z.literal('start_agent_authorization'),
    agentId: uuidSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    categories: z.array(categorySchema).min(1).max(20).optional(),
    maxTaskAtomic: amountAtomicSchema.optional(),
    totalBudgetAtomic: amountAtomicSchema.optional(),
  }).strict().superRefine((value, context) => {
    const hasExisting = value.agentId !== undefined;
    const profileFields = [value.name, value.categories, value.maxTaskAtomic, value.totalBudgetAtomic];
    if (hasExisting && profileFields.some((field) => field !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use either agentId or new profile fields.' });
    }
    if (!hasExisting && profileFields.some((field) => field === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'New profile fields are required.' });
    }
  }),
  z.object({
    action: z.literal('create_agent'),
    name: z.string().trim().min(1).max(80),
    categories: z.array(categorySchema).min(1).max(20),
    maxTaskAtomic: amountAtomicSchema,
    totalBudgetAtomic: amountAtomicSchema,
    challengeId: uuidSchema,
    signature: z.string().min(20).max(4096),
  }).strict(),
  z.object({ action: z.literal('authorize_agent'), agentId: uuidSchema, challengeId: uuidSchema, signature: z.string().min(20).max(4096) }).strict(),
  z.object({ action: z.literal('owner_create_task'), agentId: uuidSchema, ...taskFieldsSchema.shape }).strict(),
  z.object({ action: z.literal('owner_request_hire'), agentId: uuidSchema, taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('owner_review_submission'), agentId: uuidSchema, taskId: uuidSchema, decision: z.enum(['accept','request_review']), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('owner_request_release'), agentId: uuidSchema, taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('owner_request_reject'), agentId: uuidSchema, taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('accept_task'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('fund_task'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_funding'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('acknowledge_funding_fee'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('build_submission'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_submission'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('build_release'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_release'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('build_refund'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_refund'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('cancel_task'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('resolve_review'), taskId: uuidSchema, decision: z.enum(['accept','request_review']), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal('build_reject'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_reject'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('build_timeout_claim'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_timeout_claim'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('build_score_setup'), taskId: uuidSchema }).strict(),
  z.object({ action: z.literal('confirm_score_setup'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
  z.object({ action: z.literal('build_rating'), taskId: uuidSchema, stars: z.number().int().min(1).max(5) }).strict(),
  z.object({ action: z.literal('confirm_rating'), taskId: uuidSchema, digest: z.string().trim().min(20).max(128) }).strict(),
]);

export const toolInputSchemas = {
  search_workers: z.object({ category: categorySchema.optional(), area: z.string().trim().min(1).max(100).optional() }).strict(),
  create_task: taskFieldsSchema,
  get_task: z.object({ taskId: uuidSchema }).strict(),
  request_hire: z.object({ taskId: uuidSchema }).strict(),
  review_submission: z.object({ taskId: uuidSchema, decision: z.enum(['accept','request_review']), note: z.string().trim().max(1000).optional() }).strict(),
  request_release: z.object({ taskId: uuidSchema }).strict(),
  list_applicants: z.object({ taskId: uuidSchema }).strict(),
  select_worker: z.object({ taskId: uuidSchema, workerId: uuidSchema }).strict(),
} as const;

export const agentToolNameSchema = z.enum(['search_workers','create_task','get_task','request_hire','review_submission','request_release','list_applicants','select_worker']);
export const agentRequestSchema = z.object({ tool: agentToolNameSchema, input: z.unknown() }).strict();
export type TaskFields = z.infer<typeof taskFieldsSchema>;
/**
 * Direct server callers from the pre-USDC API may still pass `amountMist`.
 * Keep that call shape type-compatible while the runtime schema and all new
 * API paths use `amountAtomic`; marketplace normalizes it before touching the
 * database. Legacy values are read-only once migration 003 has run.
 */
export type LegacyTaskFields = Omit<TaskFields, 'amountAtomic'> & {
  amountAtomic?: string;
  amountMist: string;
};
export type TaskFieldsInput = TaskFields | LegacyTaskFields;
export type BrowserAction = z.infer<typeof actionSchema>;
export type AgentToolName = z.infer<typeof agentToolNameSchema>;

export function parseToolInput<T extends AgentToolName>(tool: T, input: unknown): z.infer<(typeof toolInputSchemas)[T]> {
  return toolInputSchemas[tool].parse(input) as z.infer<(typeof toolInputSchemas)[T]>;
}
