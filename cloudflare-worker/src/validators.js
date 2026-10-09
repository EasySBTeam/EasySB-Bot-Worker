// EasySB formality rules, driven by CONTRIBUTING.md and AGENTS.md:
//
//   - subjects are conventional commits, `type(scope): subject`, scope named
//     after the module, description may be Chinese;
//   - a feature branch is cut from master, never pushed as master itself;
//   - history stays linear (no merge commits inside the pull request);
//   - no co-author trailers (AGENTS.md) and, when a repository opts in, a
//     matching Signed-off-by trailer;
//   - subjects stay within soft/hard length limits, do not end in a period,
//     and a description body is separated from the subject by a blank line.
//
// Nothing here touches the network, so every rule is unit-testable on its own.

// Commit types EasySB accepts. The list is the Conventional Commits set the
// repository already uses.
export const CONVENTIONAL_TYPES = [
  'build', 'chore', 'ci', 'docs', 'feat', 'fix',
  'perf', 'refactor', 'revert', 'style', 'test'
];

// Branch names a pull request must not originate from: those are the branches
// a merge target lives on, so a PR from one is either a mistake or a bypass of
// review on master itself.
export const PROTECTED_HEAD_BRANCHES = ['master', 'main'];

// The share of commits the bot is willing to walk on a huge pull request. Kept
// low because each commit costs API budget the report also needs; a run that
// caps here reports its formality check as neutral rather than passing.
export const MAX_AUDITED_COMMITS = 100;

const AUTOSQUASH_RE = /^(fixup|squash)!/;
const REVERT_SUBJECT_RE = /^Revert ".*"$/;
const TRAILER_RE = /^[A-Za-z][A-Za-z-]*:\s+\S/;
const COAUTHOR_RE = /^co-authored-by:\s*\S+/im;

// Parses `type(scope)!: description` into its parts, or null when the subject
// is not shaped that way. A missing scope and a missing `!` are both fine.
export function parseConventionalSubject(subject) {
  const m = String(subject || '').match(/^([a-zA-Z]+)(?:\(([^)\s]+)\))?(!)?:\s+(\S.*)$/);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] || null,
    breaking: m[3] === '!',
    description: m[4],
  };
}

export function isAutosquash(subject) {
  return AUTOSQUASH_RE.test(String(subject || ''));
}

export function isMergeCommit(commit) {
  return Array.isArray(commit?.parents) && commit.parents.length > 1;
}

export function isProtectedHeadBranch(branch) {
  return PROTECTED_HEAD_BRANCHES.includes(String(branch || '').toLowerCase());
}

// A body is "only trailers" when every non-empty line looks like a
// `Key: value` trailer (Signed-off-by:, Co-authored-by:, ...). Such a body
// explains nothing, so it does not satisfy the description requirement.
export function isTrailersOnly(bodyLines) {
  const nonEmpty = (bodyLines || []).map(l => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return true;
  return nonEmpty.every(l => TRAILER_RE.test(l));
}

// Counts by Unicode code points so a Chinese subject is measured by its
// characters, not its UTF-8 byte length.
function lengthOf(text) {
  return [...String(text || '')].length;
}

// Behaviour-changing types are the ones a reviewer reads the body for; the
// rest may carry a subject alone.
const BODY_REQUIRED_TYPES = new Set(['feat', 'fix', 'perf', 'refactor']);

// --- PER-COMMIT MESSAGE RULES ---
// Returns { errors, warnings } as arrays of human-readable strings. Merge
// commits are handled by the caller and assumed filtered out before this runs.
export function validateCommitMessage(commit, config, type = null) {
  const errors = [];
  const warnings = [];
  const message = commit?.commit?.message || '';
  const lines = message.split('\n');
  const subject = (lines[0] || '').trim();
  const bodyLines = lines.slice(1);

  if (!subject) {
    errors.push('The commit has an empty subject line.');
    return { errors, warnings };
  }

  if (config.allow_autosquash && isAutosquash(subject)) {
    return { errors, warnings };
  }

  const isRevert = REVERT_SUBJECT_RE.test(subject);

  let parsed = null;
  if (config.check_conventional_commit && !isRevert) {
    parsed = parseConventionalSubject(subject);
    if (!parsed) {
      errors.push(`The subject "${subject}" is not a conventional commit. Use \`type(scope): subject\`.`);
    } else if (!CONVENTIONAL_TYPES.includes(parsed.type)) {
      errors.push(`The type "${parsed.type}" is not one of: ${CONVENTIONAL_TYPES.join(', ')}.`);
    }
  } else if (isRevert) {
    parsed = parseConventionalSubject(subject);
  }

  const ruleType = type || parsed?.type || null;

  if (config.check_trailing_period && /[.。]$/.test(subject)) {
    errors.push('The subject must not end with a period.');
  }

  if (config.check_subject_length) {
    const len = lengthOf(subject);
    if (len > config.max_subject_len_hard) {
      errors.push(`The subject is ${len} characters, over the hard limit of ${config.max_subject_len_hard}.`);
    } else if (len > config.max_subject_len_soft) {
      warnings.push(`The subject is ${len} characters, over the soft limit of ${config.max_subject_len_soft}.`);
    }
  }

  const hasBody = bodyLines.some(l => l.trim() !== '');
  if (hasBody) {
    if ((bodyLines[0] || '').trim() !== '') {
      errors.push('A blank line must separate the subject from the body.');
    }
    if (config.check_body && isTrailersOnly(bodyLines)) {
      errors.push('The body carries only trailers and explains nothing; describe what the change does and why.');
    }
  } else if (config.check_body && !isRevert && ruleType && BODY_REQUIRED_TYPES.has(ruleType)) {
    errors.push(`A \`${ruleType}\` commit needs a description body.`);
  } else if (config.check_body && !isRevert && !ruleType && !isAutosquash(subject)) {
    // A commit that never parsed as conventional gets its body checked too, so
    // the report is not silent about both problems at once.
    warnings.push('The commit has no description body.');
  }

  if (config.check_coauthor && COAUTHOR_RE.test(message)) {
    errors.push('Remove the Co-authored-by trailer: AGENTS.md asks for a single author per commit.');
  }

  if (config.check_signoff) {
    const email = commit?.commit?.author?.email || '';
    const signoff = message.match(/^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/im);
    if (!signoff) {
      errors.push('The commit is missing a `Signed-off-by:` trailer.');
    } else if (email && signoff[2].toLowerCase() !== email.toLowerCase()) {
      errors.push(`The Signed-off-by email (${signoff[2]}) does not match the author email (${email}).`);
    }
  }

  if (config.max_body_line_len) {
    for (const line of bodyLines) {
      const trimmed = line.trim();
      // Long URLs and code lines are legitimately wide; only prose is graded.
      if (!trimmed || trimmed.startsWith('http') || !trimmed.includes(' ')) continue;
      if (lengthOf(line) > config.max_body_line_len) {
        warnings.push(`A body line is over ${config.max_body_line_len} characters.`);
        break;
      }
    }
  }

  return { errors, warnings };
}

// --- WHOLE-PR COMMIT RULES ---
// Walks the commits, applying the branch rule first and then the per-commit
// rules. Returns { errors, warnings } where each entry is
// { sha, message }, suitable for rendering in commit order.
export function validateCommits(commits, config, { headBranch = null } = {}) {
  const errors = [];
  const warnings = [];

  if (config.check_branch && headBranch && isProtectedHeadBranch(headBranch)) {
    errors.push({
      sha: null,
      message: `The pull request originates from the protected branch "${headBranch}". Cut a feature branch from master instead.`,
    });
  }

  const audit = (commits || []).slice(0, MAX_AUDITED_COMMITS);
  for (const commit of audit) {
    const sha = (commit?.sha || '').slice(0, 7) || 'unknown';
    if (config.check_merge_commits && isMergeCommit(commit)) {
      errors.push({
        sha,
        message: 'This is a merge commit. Rebase onto master to keep the history linear.',
      });
      continue;
    }
    const { errors: cErrors, warnings: cWarnings } = validateCommitMessage(commit, config);
    for (const message of cErrors) errors.push({ sha, message });
    for (const message of cWarnings) warnings.push({ sha, message });
  }

  const commitScanCapped = (commits || []).length > MAX_AUDITED_COMMITS;
  return { errors, warnings, commitScanCapped };
}

// --- DIFF HYGIENE ---
// Reads a unified diff and reports the files whose added lines carry CRLF, and
// those whose last line has no trailing newline. Both are cheap facts the diff
// alone proves - unlike gofmt, which the worker cannot run.
export function validateDiffHygiene(diffText, config) {
  const errors = [];
  const warnings = [];
  if (!diffText) return { errors, warnings };

  const crlfFiles = new Set();
  const missingNewlineFiles = new Set();
  let currentFile = null;

  const lines = diffText.split('\n');
  for (const raw of lines) {
    if (raw.startsWith('+++ b/')) {
      currentFile = raw.slice(6).replace(/\r$/, '').trim();
      continue;
    }
    // An added line that still carries a carriage return means the file uses
    // CRLF line endings.
    if (config.check_crlf && currentFile && raw.startsWith('+') && !raw.startsWith('+++') && raw.endsWith('\r')) {
      crlfFiles.add(currentFile);
    }
    if (config.check_trailing_newline && raw.startsWith('\\ No newline at end of file') && currentFile) {
      missingNewlineFiles.add(currentFile);
    }
  }

  for (const file of crlfFiles) {
    errors.push(`\`${file}\` uses CRLF line endings; convert it to LF.`);
  }
  for (const file of missingNewlineFiles) {
    warnings.push(`\`${file}\` does not end with a newline.`);
  }
  return { errors, warnings };
}

// --- RENDER ---
// One section of the report: a heading and the findings beneath it, prefixed
// by `sha` when the finding belongs to a single commit.
export function renderFindings(findings) {
  return findings.map(f => (f.sha ? `- \`${f.sha}\` ${f.message}` : `- ${f.message}`)).join('\n');
}

// Builds the two check-run payloads the handler posts, along with the counts
// the caller uses to decide the `not following guidelines` label.
export function buildCheckRuns({ commits, diffText, config, headBranch, allowBranch }) {
  const commitResult = validateCommits(commits, config, { headBranch: allowBranch ? null : headBranch });
  const hygieneResult = validateDiffHygiene(diffText, config);

  return {
    commitResult,
    hygieneResult,
    failed: commitResult.errors.length > 0 || hygieneResult.errors.length > 0,
    warnings: [...commitResult.warnings, ...hygieneResult.warnings],
  };
}
