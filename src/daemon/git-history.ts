import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractFrontmatterDate } from '../core/markdown.js';

const exec = promisify(execFile);
// git emits literal NUL from `%x00` placeholder; arg stays NUL-free → execFile accepts.
const SEP = '%x00';
const NUL = '\0';
const MAX_BUF = 32 * 1024 * 1024;

/** Single git commit touching a note. `content` populated only when `withContent: true`. */
export interface Revision {
  sha: string;
  commitDate: string;
  message: string;
  authorEmail: string;
  frontmatterDate?: string;
  content?: string;
}

/** Knobs for `noteRevisions`. `maxRevisions` default 50. */
export interface HistoryOptions {
  since?: string;
  until?: string;
  withContent?: boolean;
  maxRevisions?: number;
}

/** True iff `repoPath` is inside a git worktree. */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** Newest-first revisions of `notePath` (POSIX-relative). `--follow` tracks renames. `[]` if not a repo or no log entries. */
export async function noteRevisions(
  repoPath: string,
  notePath: string,
  opts: HistoryOptions = {},
): Promise<Revision[]> {
  if (!(await isGitRepo(repoPath))) return [];
  const args = [
    '-C', repoPath, 'log', '--follow',
    `--pretty=format:%H${SEP}%aI${SEP}%s${SEP}%aE`,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  args.push('--', notePath);
  const { stdout } = await exec('git', args, { maxBuffer: MAX_BUF });
  if (!stdout.trim()) return [];
  const all: Revision[] = stdout.split('\n').filter((l) => l.length > 0).map((line) => {
    const [sha, commitDate, message, authorEmail] = line.split(NUL);
    return { sha, commitDate, message, authorEmail };
  });
  const sliced = all.slice(0, opts.maxRevisions ?? 50);
  if (!opts.withContent) return sliced;
  // parallel git-show per revision → annotate content + frontmatterDate
  const contents = await Promise.all(sliced.map((r) => noteContentAt(repoPath, r.sha, notePath)));
  return sliced.map((r, i) => {
    const content = contents[i];
    return { ...r, content, frontmatterDate: extractFrontmatterDate(content) };
  });
}

/** Note content at `sha`. Throws if `notePath` missing at that ref. */
export async function noteContentAt(repoPath: string, sha: string, notePath: string): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['-C', repoPath, 'show', `${sha}:${notePath}`],
    { maxBuffer: MAX_BUF },
  );
  return stdout;
}

