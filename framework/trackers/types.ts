export interface OpenIssue {
  number: number | string;
  title: string;
  labels: string[];
}

export interface ClosedIssue {
  number: number | string;
  title: string;
  body: string;
  labels: string[];
}

export interface IssueTracker {
  readonly name: string;
  readonly isEmpty: boolean;
  createIssue(title: string, body: string, labels: string[]): Promise<string | null>;
  fetchOpenIssues(): Promise<OpenIssue[]>;
  fetchClosedIssues(): Promise<ClosedIssue[]>;
}
