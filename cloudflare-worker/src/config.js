// Default configuration for EasySB-Bot-Worker. A repository overrides any of
// these by committing .github/formalities.json on its default branch; the
// handler merges that object over this one, so a repository only sets the keys
// it wants to change.
//
// The defaults follow CONTRIBUTING.md and AGENTS.md of EasySBTeam/EasySB:
// conventional commit subjects, feature branches cut from master, a linear
// history, and no co-author trailers.
export const DEFAULT_CONFIG = {
  // --- Git & commits ---
  check_branch: true,
  check_merge_commits: true,
  check_conventional_commit: true,
  check_subject_length: true,
  check_body: true,
  check_trailing_period: true,
  check_coauthor: true,
  // EasySB does not run a DCO, so the sign-off check is off. A repository that
  // wants it can turn it on here.
  check_signoff: false,
  allow_autosquash: true,
  allow_revert: true,
  enable_comments: true,
  max_subject_len_soft: 72,
  max_subject_len_hard: 100,
  max_body_line_len: 100,

  // --- File hygiene ---
  check_crlf: true,
  check_trailing_newline: true,

  // --- Triage ---
  // Path-based labelling from .github/labeler.yml. Reads nothing until the
  // file exists in the repository.
  enable_labeler_yml: true,
  // Stale-PR cleanup runs only when a repository opts in from the daily cron.
  enable_stale_bot: false,
  // Machine accounts whose comments and reviews must not reset the stale
  // countdown. GitHub Apps and *[bot] accounts are always ignored by shape.
  stale_ignored_users: [],
};

// The label attached to a pull request that fails a check, and cleared once a
// push makes every check pass again.
export const LABEL_GUIDELINES = 'not following guidelines';

// Colors (hex, no leading #) for labels the bot creates on demand.
export const LABEL_COLORS = {
  [LABEL_GUIDELINES]: 'd73a4a',
  stale: '6b7280',
};
