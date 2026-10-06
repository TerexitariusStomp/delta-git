import type { IssueView } from "./issues";

/**
 * GitHub-style issue search qualifiers (`is:open author:x label:"needs triage"`).
 * The grammar is a flat token list — no recursive descent needed — so this is a
 * small tokenizer + field map rather than a parser dependency. Free-text terms
 * AND-match against title and body; each qualifier may repeat (AND semantics).
 */

export type IssueQuery = {
  state?: "open" | "closed";
  author?: string;
  /** All listed assignees must be present; "*" means any assignee. */
  assignees: string[];
  /** All listed label names must be present. */
  labels: string[];
  /** Milestone title; "*" means any milestone. */
  milestone?: string;
  noLabels: boolean;
  noAssignee: boolean;
  noMilestone: boolean;
  terms: string[];
  sort?: "created" | "updated" | "comments";
  order: "asc" | "desc";
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Split on whitespace, keeping "double quoted" segments as one token. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of query) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Parse a GitHub date-comparison value (`>2024-01-01`, `<=..`) at day granularity. */
function parseDateBound(
  value: string
): { op: ">" | ">=" | "<" | "<=" | "="; at: number } | undefined {
  const match = /^(>=|<=|>|<)?(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!match) return undefined;
  const at = Date.parse(`${match[2]}T00:00:00Z`);
  if (Number.isNaN(at)) return undefined;
  return { op: (match[1] ?? "=") as ">" | ">=" | "<" | "<=" | "=", at };
}

export function parseIssueQuery(raw: string): IssueQuery {
  const query: IssueQuery = {
    assignees: [],
    labels: [],
    noLabels: false,
    noAssignee: false,
    noMilestone: false,
    terms: [],
    order: "desc",
  };

  for (const token of tokenize(raw)) {
    const colon = token.indexOf(":");
    if (colon <= 0) {
      query.terms.push(token);
      continue;
    }
    const field = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);

    switch (field) {
      case "is":
        if (value === "open" || value === "closed") query.state = value;
        break;
      case "author":
        query.author = value;
        break;
      case "assignee":
        query.assignees.push(value);
        break;
      case "label":
        query.labels.push(value);
        break;
      case "milestone":
        query.milestone = value;
        break;
      case "no":
        if (value === "label") query.noLabels = true;
        else if (value === "assignee") query.noAssignee = true;
        else if (value === "milestone") query.noMilestone = true;
        break;
      case "sort": {
        const sortMatch = /^(created|updated|comments)(?:-(asc|desc))?$/.exec(value);
        if (sortMatch) {
          query.sort = sortMatch[1] as IssueQuery["sort"];
          query.order = (sortMatch[2] ?? "desc") as "asc" | "desc";
        }
        break;
      }
      case "created":
      case "updated": {
        const bound = parseDateBound(value);
        if (!bound) break;
        const isCreated = field === "created";
        // `<`/`<=`/`=` compare against the end of the named day so a bare
        // date behaves like a whole-day predicate, matching GitHub.
        const boundAt =
          bound.op === "<" || bound.op === "<=" || bound.op === "="
            ? bound.at + DAY_MS - 1
            : bound.at;
        if (bound.op === ">" || bound.op === ">=") {
          if (isCreated) query.createdAfter = boundAt;
          else query.updatedAfter = boundAt;
        } else if (bound.op === "<" || bound.op === "<=") {
          if (isCreated) query.createdBefore = boundAt;
          else query.updatedBefore = boundAt;
        } else {
          if (isCreated) {
            query.createdAfter = bound.at;
            query.createdBefore = boundAt;
          } else {
            query.updatedAfter = bound.at;
            query.updatedBefore = boundAt;
          }
        }
        break;
      }
      default:
        // Unknown qualifier — GitHub treats it as a search term.
        query.terms.push(token);
    }
  }
  return query;
}

function withinBounds(at: number, after?: number, before?: number): boolean {
  if (after !== undefined && at < after) return false;
  if (before !== undefined && at > before) return false;
  return true;
}

export function issueMatchesQuery(issue: IssueView, query: IssueQuery): boolean {
  if (query.state && issue.state !== query.state) return false;
  if (query.author && issue.author !== query.author) return false;
  if (query.assignees.length > 0) {
    if (query.assignees.includes("*")) {
      if (issue.assignees.length === 0) return false;
    } else if (!query.assignees.every((a) => issue.assignees.includes(a))) {
      return false;
    }
  }
  if (query.labels.length > 0) {
    const names = new Set(issue.labels.map((label) => label.name));
    if (!query.labels.every((label) => names.has(label))) return false;
  }
  if (query.milestone !== undefined) {
    if (query.milestone === "*") {
      if (!issue.milestone) return false;
    } else if (issue.milestone?.title !== query.milestone) {
      return false;
    }
  }
  if (query.noLabels && issue.labels.length > 0) return false;
  if (query.noAssignee && issue.assignees.length > 0) return false;
  if (query.noMilestone && issue.milestone) return false;
  if (!withinBounds(issue.createdAt, query.createdAfter, query.createdBefore)) return false;
  if (!withinBounds(issue.updatedAt, query.updatedAfter, query.updatedBefore)) return false;

  if (query.terms.length > 0) {
    const haystack = `${issue.title}\n${issue.body ?? ""}`.toLowerCase();
    if (!query.terms.every((term) => haystack.includes(term.toLowerCase()))) return false;
  }
  return true;
}

export function sortIssues(issues: IssueView[], query: IssueQuery): IssueView[] {
  if (!query.sort) return issues;
  const key = (issue: IssueView): number =>
    query.sort === "comments"
      ? issue.comments
      : query.sort === "updated"
        ? issue.updatedAt
        : issue.createdAt;
  const direction = query.order === "asc" ? 1 : -1;
  return [...issues].sort((a, b) => (key(a) - key(b)) * direction);
}
