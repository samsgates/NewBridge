import { z } from 'zod';

export type Operation = 'read' | 'create' | 'update' | 'delete' | 'execute';
export interface PolicyContext {
  actor?: string;
  actorType?: 'user' | 'service' | 'agent';
  connection: string;
  table: string;
  operation: Operation;
  fields?: string[];
  payload?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  filteredFields?: string[];
  approvalRequired?: boolean;
  approvalReason?: string;
}

const RuleSchema = z.object({
  tables: z.array(z.string()).default(['*']),
  operations: z.array(z.enum(['read', 'create', 'update', 'delete', 'execute'])).default(['read']),
  fields: z.array(z.string()).optional(),
  actors: z.array(z.string()).optional(),
  connections: z.array(z.string()).optional(),
});

const ApprovalSchema = RuleSchema.extend({ reason: z.string().optional() });

export const PolicyDocumentSchema = z.object({
  default: z.enum(['allow', 'deny']).default('deny'),
  allow: z.array(RuleSchema).default([]),
  deny: z.array(RuleSchema).default([]),
  approvals: z.array(ApprovalSchema).default([]),
  redaction: z.object({ fields: z.array(z.string()).default([]), regex: z.array(z.string()).default([]) }).default({ fields: [], regex: [] }),
});

export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function ruleMatches(rule: z.infer<typeof RuleSchema>, ctx: PolicyContext): boolean {
  if (!rule.tables.some(p => wildcardMatch(p, ctx.table))) return false;
  if (!rule.operations.includes(ctx.operation)) return false;
  if (rule.actors?.length && !rule.actors.some(p => wildcardMatch(p, ctx.actor ?? ''))) return false;
  if (rule.connections?.length && !rule.connections.some(p => wildcardMatch(p, ctx.connection))) return false;
  return true;
}

export class PolicyEngine {
  readonly policy: PolicyDocument;
  constructor(document: unknown) { this.policy = PolicyDocumentSchema.parse(document); }

  evaluate(ctx: PolicyContext): PolicyDecision {
    const deny = this.policy.deny.find(rule => ruleMatches(rule, ctx));
    if (deny) return { allowed: false, reason: 'Denied by explicit policy rule' };

    const allowRules = this.policy.allow.filter(rule => ruleMatches(rule, ctx));
    const allowedByDefault = this.policy.default === 'allow';
    if (!allowRules.length && !allowedByDefault) return { allowed: false, reason: 'No allow rule matched' };

    let filteredFields = ctx.fields;
    if (allowRules.length && ctx.fields?.length) {
      const unrestricted = allowRules.some(r => !r.fields?.length || r.fields.includes('*'));
      if (!unrestricted) {
        const allowedFields = new Set(allowRules.flatMap(r => r.fields ?? []));
        filteredFields = ctx.fields.filter(f => allowedFields.has(f));
        if (ctx.operation !== 'read' && filteredFields.length !== ctx.fields.length) {
          const rejected = ctx.fields.filter(f => !allowedFields.has(f));
          return { allowed: false, reason: `Fields not permitted: ${rejected.join(', ')}` };
        }
      }
    }

    const approval = this.policy.approvals.find(rule => ruleMatches(rule, ctx));
    return {
      allowed: true,
      reason: allowRules.length ? 'Allowed by policy rule' : 'Allowed by default policy',
      filteredFields,
      approvalRequired: Boolean(approval),
      approvalReason: approval?.reason ?? (approval ? 'Operation requires approval' : undefined)
    };
  }

  redact<T>(value: T): T {
    const fieldSet = new Set(this.policy.redaction.fields.map(f => f.toLowerCase()));
    const regexes = this.policy.redaction.regex.map(r => new RegExp(r, 'gi'));
    const walk = (input: unknown, key?: string): unknown => {
      if (key && fieldSet.has(key.toLowerCase())) return '[REDACTED]';
      if (typeof input === 'string') return regexes.reduce((v, r) => v.replace(r, '[REDACTED]'), input);
      if (Array.isArray(input)) return input.map(v => walk(v));
      if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, walk(v, k)]));
      return input;
    };
    return walk(value) as T;
  }
}
