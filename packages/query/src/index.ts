export type Scalar = string | number | boolean | null | Date;
export type Operator =
  | '=' | '!=' | '>' | '>=' | '<' | '<=' | 'IN' | 'NOT IN'
  | 'LIKE' | 'NOT LIKE' | 'STARTSWITH' | 'ENDSWITH'
  | 'ISEMPTY' | 'ISNOTEMPTY' | 'BETWEEN' | 'INSTANCEOF';

export interface Condition {
  kind: 'condition';
  field: string;
  operator: Operator;
  value?: Scalar | Scalar[] | [Scalar, Scalar];
}

export interface Group {
  kind: 'group';
  op: 'AND' | 'OR';
  nodes: QueryNode[];
}

export type QueryNode = Condition | Group;

const FIELD_RE = /^[A-Za-z0-9_.]+$/;

function assertField(field: string): void {
  if (!FIELD_RE.test(field)) throw new Error(`Invalid ServiceNow field path: ${field}`);
}

function encodeScalar(value: Scalar, reserved = '^'): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  const text = String(value);
  for (const character of reserved) {
    if (text.includes(character)) {
      throw new Error(`Value contains reserved encoded-query character ${JSON.stringify(character)}. NewBridge refuses to concatenate this value because ServiceNow encoded queries cannot safely represent it in this operator.`);
    }
  }
  if (/^[=!<>]/.test(text)) throw new Error('Value begins with an encoded-query operator character and is rejected for safety');
  return text;
}

function encodeCondition(condition: Condition): string {
  assertField(condition.field);
  const { field, operator, value } = condition;
  if (operator === 'ISEMPTY' || operator === 'ISNOTEMPTY') return `${field}${operator}`;
  if (operator === 'BETWEEN') {
    if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires exactly two values');
    return `${field}BETWEEN${encodeScalar(value[0] as Scalar, '^@')}@${encodeScalar(value[1] as Scalar, '^@')}`;
  }
  if (operator === 'IN' || operator === 'NOT IN') {
    if (!Array.isArray(value)) throw new Error(`${operator} requires an array`);
    return `${field}${operator.replace(' ', '')}${value.map(v => encodeScalar(v as Scalar, '^,')).join(',')}`;
  }
  if (value === undefined) throw new Error(`${operator} requires a value`);
  return `${field}${operator.replace(' ', '')}${encodeScalar(value as Scalar)}`;
}

export function encodeQuery(node?: QueryNode): string {
  if (!node) return '';
  if (node.kind === 'condition') return encodeCondition(node);
  const separator = node.op === 'AND' ? '^' : '^OR';
  return node.nodes.map(encodeQuery).filter(Boolean).join(separator);
}

export class QueryBuilder {
  private root: Group = { kind: 'group', op: 'AND', nodes: [] };
  private order: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private selectedFields: string[] = [];
  private maxRows?: number;
  private offsetRows?: number;

  where(field: string, value: Scalar): this;
  where(field: string, operator: Operator, value?: Condition['value']): this;
  where(field: string, operatorOrValue: Operator | Scalar, value?: Condition['value']): this {
    const isOperator = typeof operatorOrValue === 'string' && [
      '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE',
      'STARTSWITH', 'ENDSWITH', 'ISEMPTY', 'ISNOTEMPTY', 'BETWEEN', 'INSTANCEOF'
    ].includes(operatorOrValue);
    const operator: Operator = isOperator ? operatorOrValue as Operator : '=';
    const finalValue = isOperator ? value : operatorOrValue as Scalar;
    assertField(field);
    this.root.nodes.push({ kind: 'condition', field, operator, value: finalValue });
    return this;
  }

  whereIn(field: string, values: Scalar[]): this { return this.where(field, 'IN', values); }
  whereNotIn(field: string, values: Scalar[]): this { return this.where(field, 'NOT IN', values); }
  whereEmpty(field: string): this { return this.where(field, 'ISEMPTY'); }
  whereNotEmpty(field: string): this { return this.where(field, 'ISNOTEMPTY'); }

  orWhere(field: string, value: Scalar): this;
  orWhere(field: string, operator: Operator, value?: Condition['value']): this;
  orWhere(field: string, operatorOrValue: Operator | Scalar, value?: Condition['value']): this {
    const isOperator = typeof operatorOrValue === 'string' && [
      '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE',
      'STARTSWITH', 'ENDSWITH', 'ISEMPTY', 'ISNOTEMPTY', 'BETWEEN', 'INSTANCEOF'
    ].includes(operatorOrValue);
    const operator: Operator = isOperator ? operatorOrValue as Operator : '=';
    const finalValue = isOperator ? value : operatorOrValue as Scalar;
    assertField(field);
    const last = this.root.nodes.pop();
    const node: Condition = { kind: 'condition', field, operator, value: finalValue };
    if (!last) this.root.nodes.push(node);
    else if (last.kind === 'group' && last.op === 'OR') { last.nodes.push(node); this.root.nodes.push(last); }
    else this.root.nodes.push({ kind: 'group', op: 'OR', nodes: [last, node] });
    return this;
  }

  group(op: 'AND' | 'OR', callback: (qb: QueryBuilder) => void): this {
    const nested = new QueryBuilder();
    callback(nested);
    this.root.nodes.push({ kind: 'group', op, nodes: nested.root.nodes });
    return this;
  }

  select(fields: string[]): this {
    fields.forEach(assertField);
    this.selectedFields = [...new Set(fields)];
    return this;
  }

  orderBy(field: string): this { assertField(field); this.order.push({ field, direction: 'ASC' }); return this; }
  orderByDesc(field: string): this { assertField(field); this.order.push({ field, direction: 'DESC' }); return this; }
  limit(limit: number): this { if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer'); this.maxRows = limit; return this; }
  offset(offset: number): this { if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer'); this.offsetRows = offset; return this; }

  toEncodedQuery(): string {
    const base = encodeQuery(this.root);
    const ordering = this.order.map(o => `ORDERBY${o.direction === 'DESC' ? 'DESC' : ''}${o.field}`).join('^');
    return [base, ordering].filter(Boolean).join('^');
  }

  toParams(): URLSearchParams {
    const params = new URLSearchParams();
    const query = this.toEncodedQuery();
    if (query) params.set('sysparm_query', query);
    if (this.selectedFields.length) params.set('sysparm_fields', this.selectedFields.join(','));
    if (this.maxRows !== undefined) params.set('sysparm_limit', String(this.maxRows));
    if (this.offsetRows !== undefined) params.set('sysparm_offset', String(this.offsetRows));
    return params;
  }

  clone(): QueryBuilder {
    const qb = new QueryBuilder();
    qb.root = structuredClone(this.root);
    qb.order = structuredClone(this.order);
    qb.selectedFields = [...this.selectedFields];
    qb.maxRows = this.maxRows;
    qb.offsetRows = this.offsetRows;
    return qb;
  }
}
