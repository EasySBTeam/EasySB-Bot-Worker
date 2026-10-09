import { DEFAULT_CONFIG, LABEL_GUIDELINES, LABEL_COLORS } from './config.js';
import { parseYaml, getLabelsForChangedFiles, getAllChangedFiles } from './labeler.js';
import { verifySignature, getInstallationToken } from './crypto.js';
import { githubApiCall, graphqlFetchRepoSetup, ensureLabelExists, fetchUserRepoPermission } from './github.js';
import { buildCheckRuns, renderFindings } from './validators.js';
import { handleScheduled } from './stale.js';

// The header this app puts on its own pull request comment. It is how a later
// run finds the comment it wrote so it can be edited or removed.
const COMMENT_HEADER = '## Formality Check: EasySB';

// Override commands, recognized both in the pull request description and in a
// maintainer's comment. `[allow branch]` waives the protected-branch rule for a
// pull request a maintainer deliberately opened from master.
const ALLOW_BRANCH_PATTERN = /\[allow[ -]branch\]/i;

// author_association values that identify a maintainer on their own. Anything
// else needs the repository permission lookup.
const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const ACCEPT_DIFF = 'application/vnd.github.v3.diff';

// --- SMALL HELPERS ---
// Bots never act as maintainers here: this app's own reports quote the override
// commands back at the pull request, so honoring a bot comment would let it
// re-trigger itself.
function isBotUser(user) {
  const login = user?.login;
  return user?.type === 'Bot' || (!!login && login.toLowerCase().endsWith('[bot]'));
}

// Parses an env var as an integer, honoring an explicitly configured 0 rather
// than treating it the same as "not set".
function parseEnvInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function safeTruncate(text, limit = 65000) {
  if (!text) return '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;

  const suffix = '\n\n... [Output truncated due to GitHub character limit] ...';
  const suffixBytes = encoder.encode(suffix);
  const truncatedText = decoder.decode(bytes.slice(0, limit - suffixBytes.length));
  return (truncatedText.endsWith('\uFFFD') ? truncatedText.slice(0, -1) : truncatedText) + suffix;
}

// The subrequest budget counts every outgoing fetch, retries included (see
// github.js). SUBREQUEST_RESERVE_HEADROOM is kept off the top for the writes
// that must always go out, so a huge pull request can never starve the report.
function createBudget(env) {
  return {
    limit: parseEnvInt(env.SUBREQUEST_BUDGET_LIMIT, 45),
    reserve: parseEnvInt(env.SUBREQUEST_RESERVE_HEADROOM, 15),
    used: 0,
  };
}

function budgetCounter(budget) {
  return (attempt) => {
    if (attempt > 1 && budget.limit - budget.reserve - budget.used <= 0) return false;
    budget.used++;
    return true;
  };
}

// Memoized per request: the same login shows up as pull request author and as
// comment author, and every lookup costs a subrequest.
function createMaintainerResolver(repoFullname, token, budget) {
  const cache = new Map();
  return async function isMaintainerUser(user, association) {
    if (isBotUser(user)) return false;
    if (MAINTAINER_ASSOCIATIONS.includes((association || '').toUpperCase())) return true;
    const login = user?.login;
    if (!login) return false;
    const cacheKey = login.toLowerCase();
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (budget.limit - budget.reserve - budget.used <= 0) return false;
    const pending = fetchUserRepoPermission(repoFullname, login, token, budgetCounter(budget))
      .then(hasWriteAccess => {
        // A failed lookup is not evidence of missing access, so it must not
        // stick: drop it and let a later question retry.
        if (hasWriteAccess === null) {
          cache.delete(cacheKey);
          return false;
        }
        return hasWriteAccess;
      });
    cache.set(cacheKey, pending);
    return pending;
  };
}

// --- COMMENT SCAN ---
// Reads the facts a run needs from a list of issue comments: the id of this
// app's own earlier report, and whether a maintainer left the override command.
async function scanCommentList(comments, isMaintainerUser, appId, scan) {
  for (const c of comments) {
    // A comment says it is this app's own through GraphQL's viewerDidAuthor, or
    // through REST's performed_via_github_app.id. Matching on the header text
    // alone would let anyone plant a comment this bot then edits or deletes.
    const isOwn = c.viewer_did_author === true ||
      (appId && c.performed_via_github_app?.id === appId);
    if (isOwn && c.body?.startsWith(COMMENT_HEADER)) {
      scan.existingCommentId = c.id;
    }
    if (ALLOW_BRANCH_PATTERN.test(c.body || '') && await isMaintainerUser(c.user, c.author_association)) {
      scan.hasBranchBypassComment = true;
    }
  }
  return scan;
}

// `hasHeadroom` is asked before every page after the first: a thread long
// enough to page is also long enough to eat the headroom kept for the closing
// writes, and losing those loses the whole report.
async function scanPrComments(repoFullname, prNumber, token, budget, isMaintainerUser, appId, hasHeadroom = () => true) {
  let page = 1;
  const scan = { hasBranchBypassComment: false, existingCommentId: null };

  while (true) {
    const url = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments?per_page=100&page=${page}`;
    const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) });
    if (res.code !== 200 || !Array.isArray(res.data)) return null;
    await scanCommentList(res.data, isMaintainerUser, appId, scan);
    if (res.data.length < 100) break;
    if (!hasHeadroom()) {
      console.warn(`Comment scan for PR #${prNumber} stopped after page ${page}: no request budget left beyond the reserve.`);
      return null;
    }
    page++;
  }
  return scan;
}

// --- STATUS WRITES ---
// Runs a write and records its status so the handler can report a 502 when any
// of the terminal writes failed.
async function trackedWrite(writes, what, fn) {
  const res = await fn();
  writes.push({ what, code: res?.code ?? 0 });
  return res;
}

// --- REPORT BODY ---
function buildCommentBody(build) {
  const { commitResult, hygieneResult } = build;
  const lines = [COMMENT_HEADER, ''];

  if (build.failed) {
    lines.push('Some checks failed. Fix the findings below and push again; this comment updates itself.');
    lines.push('All required checks pass. A few suggestions are noted below.');
  } else {
    lines.push('All checks pass.');
  }

  const sections = [
    ['Git & Commits', commitResult.errors, commitResult.warnings, commitResult.commitScanCapped],
    ['File Hygiene', hygieneResult.errors, hygieneResult.warnings, false],
  ];

  for (const [title, errors, warnings, capped] of sections) {
    if (errors.length === 0 && warnings.length === 0 && !capped) continue;
    lines.push('', `### ${title}`, '');
    if (errors.length > 0) {
      lines.push('**Must fix**', '', renderFindings(errors), '');
    }
    if (warnings.length > 0) {
      lines.push('**Suggestions**', '', renderFindings(warnings), '');
    }
    if (capped) {
      lines.push('> Only the first commits were inspected; the audit is capped on very large pull requests.', '');
    }
  }

  lines.push(
    '',
    '---',
    '格式与规范由 EasySB-Bot 自动检查，详细规则见仓库 `CONTRIBUTING.md`。',
    'Formalities are checked automatically by EasySB-Bot; see `CONTRIBUTING.md` for the rules.'
  );
  return lines.join('\n');
}

// --- WEBHOOK HANDLER ---
async function handleWebhook(request, env) {
  const payloadText = await request.text();
  const signature = request.headers.get('x-hub-signature-256') || '';

  if (!await verifySignature(payloadText, signature, env.WEBHOOK_SECRET)) {
    console.error('Webhook signature verification failed.');
    return new Response('Invalid signature', { status: 403 });
  }

  const data = JSON.parse(payloadText);
  const event = request.headers.get('x-github-event');
  if (event !== 'pull_request') {
    return new Response('Not a pull request event', { status: 200 });
  }

  // "edited" matters: the description carries the override command, and a
  // retargeted base branch changes the diff. Both arrive as an edit, not as a
  // synchronize. An edit that touched neither cannot change any verdict.
  const action = data.action || '';
  if (!['opened', 'synchronize', 'reopened', 'edited'].includes(action)) {
    return new Response('Ignored pull request action', { status: 200 });
  }
  if (action === 'edited' && !data.changes?.base && !data.changes?.body) {
    return new Response('Pull request edit changed neither the base branch nor the description', { status: 200 });
  }

  const installationId = data.installation?.id;
  if (!installationId) {
    console.error('Webhook processing failed: Missing installation ID in payload.');
    return new Response('Missing installation ID', { status: 400 });
  }

  const repoFullname = data.repository?.full_name;
  const pr = data.pull_request;
  if (!repoFullname || !pr) {
    console.error('Webhook processing failed: Missing repository or pull request in payload.');
    return new Response('Missing repository', { status: 400 });
  }

  const budget = createBudget(env);
  const appId = Number(env.APP_ID) || null;
  const counter = budgetCounter(budget);

  const token = await getInstallationToken(installationId, env.APP_ID, env.PRIVATE_KEY, counter);
  if (!token) {
    console.error(`Webhook processing failed: Could not mint an installation token for ${installationId}.`);
    return new Response('Could not generate installation access token', { status: 500 });
  }

  const prNumber = pr.number;
  const headSha = pr.head?.sha;
  const headBranch = pr.head?.ref || null;
  const defaultBranch = data.repository.default_branch || 'master';

  // Configuration and labeler read from the default branch, never from the
  // pull request head: otherwise a pull request could switch off the checks
  // that judge it.
  const setup = await graphqlFetchRepoSetup(
    token, repoFullname, defaultBranch,
    '.github/formalities.json', '.github/labeler.yml',
    counter, prNumber
  );

  let config = DEFAULT_CONFIG;
  if (setup.configText) {
    try {
      const repoConfig = JSON.parse(setup.configText);
      if (repoConfig && typeof repoConfig === 'object') {
        config = { ...DEFAULT_CONFIG, ...repoConfig };
      }
    } catch (e) {
      console.warn(`formalities.json in ${repoFullname} could not be parsed, falling back to defaults: ${e.message}`);
    }
  }

  // The unified diff serves both the file-hygiene checks and the path labeler,
  // so it is fetched once.
  const diffRes = await githubApiCall(
    `https://api.github.com/repos/${repoFullname}/pulls/${prNumber}`,
    token, 'GET', null, ACCEPT_DIFF, { onAttempt: counter }
  );
  const diffText = diffRes.code === 200 ? diffRes.raw : null;
  const patchUnavailable = diffText === null;

  // Read the override command from the description, and this app's own earlier
  // comment plus any maintainer override from the thread.
  const isMaintainerUser = createMaintainerResolver(repoFullname, token, budget);
  let allowBranch = ALLOW_BRANCH_PATTERN.test(pr.body || '');
  let existingCommentId = null;
  const hasHeadroom = () => budget.limit - budget.reserve - budget.used > 0;

  if (Array.isArray(setup.comments)) {
    const scan = await scanCommentList(setup.comments, isMaintainerUser, appId, { hasBranchBypassComment: false, existingCommentId: null });
    existingCommentId = scan.existingCommentId;
    allowBranch = allowBranch || scan.hasBranchBypassComment;
  } else {
    const scan = await scanPrComments(repoFullname, prNumber, token, budget, isMaintainerUser, appId, hasHeadroom);
    if (scan) {
      existingCommentId = scan.existingCommentId;
      allowBranch = allowBranch || scan.hasBranchBypassComment;
    }
  }

  const build = buildCheckRuns({
    commits: setup.commits || [],
    diffText: diffText || '',
    config,
    headBranch,
    allowBranch,
  });

  // Path-based labels, only ever added, plus the guidelines label the pass/fail
  // verdict controls.
  const changedFiles = getAllChangedFiles(diffText || '');
  let matchedLabels = [];
  if (config.enable_labeler_yml && setup.labelerText) {
    try {
      matchedLabels = getLabelsForChangedFiles(changedFiles, parseYaml(setup.labelerText));
    } catch (e) {
      console.warn(`labeler.yml in ${repoFullname} could not be parsed: ${e.message}`);
    }
  }

  const labelsToAdd = [...matchedLabels];
  if (build.failed) labelsToAdd.push(LABEL_GUIDELINES);
  const labelsToRemove = build.failed ? [] : [LABEL_GUIDELINES];

  // --- TERMINAL WRITES ---
  const writes = [];
  const labelBase = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/labels`;
  const existingLabels = setup.labels;

  for (const name of labelsToAdd) {
    await trackedWrite(writes, `label add "${name}"`, async () => {
      await ensureLabelExists(token, repoFullname, name, LABEL_COLORS[name] || 'ededed', '', existingLabels, budgetCounter(budget));
      return githubApiCall(labelBase, token, 'POST', { labels: [name] }, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) });
    });
  }
  for (const name of labelsToRemove) {
    await trackedWrite(writes, `label remove "${name}"`, () => githubApiCall(
      `${labelBase}/${encodeURIComponent(name)}`, token, 'DELETE', null,
      'application/vnd.github+json', { silent: true, onAttempt: budgetCounter(budget) }
    ));
  }

  if (config.enable_comments) {
    const commentUrl = `https://api.github.com/repos/${repoFullname}/issues/${prNumber}/comments`;
    const hasFindings = build.failed || build.warnings.length > 0;
    if (hasFindings) {
      const body = safeTruncate(buildCommentBody(build));
      await trackedWrite(writes, 'PR comment', () => existingCommentId
        ? githubApiCall(`https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'PATCH', { body }, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) })
        : githubApiCall(commentUrl, token, 'POST', { body }, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) }));
    } else if (existingCommentId) {
      await trackedWrite(writes, 'PR comment removal', () => githubApiCall(
        `https://api.github.com/repos/${repoFullname}/issues/comments/${existingCommentId}`, token, 'DELETE',
        null, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) }
      ));
    }
  }

  // --- CHECK RUNS ---
  const checkRunsUrl = `https://api.github.com/repos/${repoFullname}/check-runs`;
  const conclusionFor = (passed, incomplete) => (!passed ? 'failure' : (incomplete ? 'neutral' : 'success'));
  const INCOMPLETE_NOTE = ' Part of this pull request could not be inspected, so this check reports neutral instead of a pass.';

  const commitPassed = build.commitResult.errors.length === 0;
  const commitIncomplete = build.commitResult.commitScanCapped;
  const hygienePassed = build.hygieneResult.errors.length === 0;
  const hygieneIncomplete = patchUnavailable;

  const renderSection = (errors, warnings) => {
    const parts = [];
    if (errors.length > 0) parts.push('Must fix:\n' + renderFindings(errors));
    if (warnings.length > 0) parts.push('Suggestions:\n' + renderFindings(warnings));
    return parts.join('\n\n') || 'No problems found.';
  };

  const checkRunDefs = [
    {
      name: 'FormalityCheck / Git & Commits',
      passed: commitPassed,
      incomplete: commitIncomplete,
      title: commitPassed ? (commitIncomplete ? 'Git & Commits: Partially checked' : 'Git & Commits: Passed') : 'Git & Commits: Failed',
      summary: (commitPassed ? 'Branch target, commit format and history follow CONTRIBUTING.md.' : 'Some commits do not follow the guidelines - open the details below.') +
        (commitIncomplete ? INCOMPLETE_NOTE : ''),
      text: renderSection(build.commitResult.errors, build.commitResult.warnings),
    },
    {
      name: 'FormalityCheck / File Hygiene',
      passed: hygienePassed,
      incomplete: hygieneIncomplete,
      title: hygienePassed ? (hygieneIncomplete ? 'File Hygiene: Partially checked' : 'File Hygiene: Passed') : 'File Hygiene: Failed',
      summary: (hygienePassed ? 'Line endings and trailing newlines follow the repository style.' : 'Some files need fixing - open the details below.') +
        (hygieneIncomplete ? INCOMPLETE_NOTE : ''),
      text: renderSection(build.hygieneResult.errors, build.hygieneResult.warnings),
    },
  ];

  for (const def of checkRunDefs) {
    await trackedWrite(writes, `check-run "${def.name}"`, () => githubApiCall(checkRunsUrl, token, 'POST', {
      name: def.name,
      head_sha: headSha,
      status: 'completed',
      conclusion: conclusionFor(def.passed, def.incomplete),
      output: { title: def.title, summary: safeTruncate(def.summary, 65535), text: safeTruncate(def.text) },
    }, 'application/vnd.github+json', { onAttempt: budgetCounter(budget) }));
  }

  const failedWrites = writes.filter(w => !(w.code >= 200 && w.code < 300));
  if (failedWrites.length > 0) {
    const summary = failedWrites.map(w => `${w.what} (HTTP ${w.code || 'no response'})`).join(', ');
    console.error(`Status reporting for PR #${prNumber} failed: ${summary}`);
    return new Response(`Failed to report status for PR #${prNumber}: ${summary}`, { status: 502 });
  }

  return new Response(`Success: Processed check runs for PR #${prNumber}`, { status: 200 });
}

// --- FETCH ENTRYPOINT ---
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/webhook') {
        // GitHub gives up on a delivery after ten seconds; registering the work
        // keeps it alive for up to thirty seconds past that. The answer still
        // waits for it, so the delivery log keeps showing failures.
        const work = handleWebhook(request, env);
        ctx?.waitUntil?.(work.catch(() => {}));
        return await work;
      }

      return new Response('Invalid Request', { status: 400 });
    } catch (rawError) {
      console.error('Webhook processing failed:', rawError);
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      return new Response(JSON.stringify({
        exception: { name: rawError?.name || 'Error', message, timestamp: Date.now() },
        message,
      }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
