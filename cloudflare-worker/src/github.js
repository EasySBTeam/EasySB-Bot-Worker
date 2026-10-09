// --- GITHUB API HELPER ---
// `options.onAttempt` is invoked immediately before every outgoing fetch,
// retries included, with the attempt number. Cloudflare counts each of those
// against the per-invocation subrequest cap, so a caller that only counted the
// call itself would treat a request that failed twice as one and could then
// exhaust the real cap while still believing it had headroom left (see the
// budget in index.js). Returning `false` from it declines the attempt: the
// request is not made and the last answer is returned as is, or, when there
// was none, a 599 saying so - never null, because every caller reads `.code`.

// The longest Retry-After a webhook run waits out. GitHub expects the answer
// to a delivery within ten seconds, and a run has other work left after a
// rate-limited write.
const MAX_RETRY_AFTER_SECONDS = 5;

export async function githubApiCall(url, token, method = 'GET', payload = null, customAccept = 'application/vnd.github+json', options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': customAccept,
    'User-Agent': 'EasySB-Bot'
  };

  const fetchOptions = {
    method,
    headers
  };

  if (payload && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    fetchOptions.body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  const maxAttempts = 3;
  const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';
  let delay = isTestEnv ? 1 : 500;

  // What a declined attempt returns when nothing was tried yet. Shaped like
  // every other answer so callers can read it without a null check; 599 is the
  // same code a network failure reports, and no caller treats it as success.
  let lastResult = {
    code: 599,
    data: null,
    raw: 'Request not made: the caller declined the attempt',
    headers: { get: () => null }
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.onAttempt?.(attempt) === false) {
        console.warn(`GitHub API call not retried, no request budget left: ${method} ${url}`);
        return lastResult;
      }
      const response = await fetch(url, fetchOptions);
      const text = await response.text();

      // Retry on 5xx status codes (transient GitHub issues).
      const isRetryable5xx = response.status >= 500 && response.status < 600;
      if (isRetryable5xx && attempt < maxAttempts) {
        lastResult = { code: response.status, data: null, raw: text, headers: response.headers };
        console.warn(`GitHub API call failed with HTTP ${response.status} (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      // GitHub's secondary rate limits (too many writes in a short burst)
      // answer with 403 or 429 and a Retry-After header. Retrying before that
      // time has passed only earns the same answer again, so the wait is
      // either honoured in full or, when it would not fit inside a webhook,
      // the answer is taken as final. Without the header a 403 is a real
      // refusal and is not retried.
      const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
      const isRateLimited = (response.status === 403 || response.status === 429) && retryAfterSeconds > 0;
      if (isRateLimited && attempt < maxAttempts) {
        if (retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
          console.warn(`GitHub API rate limited: ${method} ${url} -> HTTP ${response.status}, Retry-After ${retryAfterSeconds}s is longer than a webhook can wait. Giving up.`);
        } else {
          lastResult = { code: response.status, data: null, raw: text, headers: response.headers };
          const wait = isTestEnv ? 1 : retryAfterSeconds * 1000;
          console.warn(`GitHub API rate limited: ${method} ${url} -> HTTP ${response.status} (attempt ${attempt}/${maxAttempts}). Retrying in ${wait}ms...`);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }
      }

      if (response.status >= 400) {
        // A 404 on GET /contents/ is expected noise: file lookups routinely
        // probe paths that may not exist.
        const isExpected404 = response.status === 404 &&
          method === 'GET' && url.includes('/contents/');
        // 404/422 is expected only for opt-in callers (options.silent): the
        // commit fallback after a force-push, permission probes for users who
        // are not collaborators, and label deletions racing another writer.
        const isSilencedMiss = options.silent === true &&
          (response.status === 404 || response.status === 422);
        if (!isExpected404 && !isSilencedMiss) {
          console.error(`GitHub API call failed: ${method} ${url} -> HTTP ${response.status}: ${text.trim().slice(0, 500)}`);
        }
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}

      return {
        code: response.status,
        data,
        raw: text,
        headers: response.headers
      };
    } catch (error) {
      if (attempt < maxAttempts) {
        lastResult = { code: 599, data: null, raw: error.message, headers: { get: () => null } };
        console.warn(`GitHub API call network error (attempt ${attempt}/${maxAttempts}): ${error.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      console.error(`GitHub API call failed permanently: ${method} ${url} -> ${error.message}`);
      return {
        code: 599,
        data: null,
        raw: error.message,
        headers: { get: () => null }
      };
    }
  }
}

// --- GRAPHQL BATCH FILE FETCH ---
// Fetches raw content for many (repo, ref, path) triples in as few HTTP
// subrequests as possible. GitHub's REST Contents API serves one file per
// call; GraphQL lets us alias dozens of `object(expression: "ref:path")`
// lookups into a single POST, which matters under the Workers subrequest cap.
export const GRAPHQL_URL = 'https://api.github.com/graphql';

// probes: Array<{ key, repoFullname, ref, path }>
// Returns Map<key, { content, exists, isBinary } | { error: Error }>.
export async function graphqlBatchFetchFiles(token, probes, onCall) {
  const results = new Map();
  if (!probes || probes.length === 0) return results;

  const groups = new Map(); // repoFullname -> probes[]
  for (const probe of probes) {
    if (!groups.has(probe.repoFullname)) groups.set(probe.repoFullname, []);
    groups.get(probe.repoFullname).push(probe);
  }

  const varDefs = [];
  const variables = {};
  const queryParts = [];
  const probeMeta = [];

  let repoIndex = 0;
  for (const [repoFullname, groupProbes] of groups) {
    const slashIndex = repoFullname.indexOf('/');
    const owner = repoFullname.slice(0, slashIndex);
    const name = repoFullname.slice(slashIndex + 1);
    const repoAlias = `repo${repoIndex}`;
    const oVar = `o${repoIndex}`;
    const nVar = `n${repoIndex}`;
    varDefs.push(`$${oVar}: String!`, `$${nVar}: String!`);
    variables[oVar] = owner;
    variables[nVar] = name;

    const fieldParts = [];
    groupProbes.forEach((probe, probeIndex) => {
      const fieldAlias = `f${probeIndex}`;
      const eVar = `e${repoIndex}_${probeIndex}`;
      varDefs.push(`$${eVar}: String!`);
      variables[eVar] = probe.path ? `${probe.ref}:${probe.path}` : `${probe.ref}`;
      fieldParts.push(`${fieldAlias}: object(expression: $${eVar}) { oid ... on Blob { text isBinary } }`);
      probeMeta.push({ key: probe.key, repoAlias, fieldAlias });
    });

    queryParts.push(`${repoAlias}: repository(owner: $${oVar}, name: $${nVar}) {\n    ${fieldParts.join('\n    ')}\n  }`);
    repoIndex++;
  }

  const query = `query(${varDefs.join(', ')}) {\n  ${queryParts.join('\n  ')}\n}`;

  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables }, 'application/vnd.github+json', { onAttempt: onCall });

  if (res.code !== 200 || !res.data) {
    const cleanRaw = (res.raw || "").trim().slice(0, 200);
    const err = new Error(`GraphQL batch file fetch failed (HTTP ${res.code}): ${cleanRaw}`);
    for (const probe of probes) results.set(probe.key, { error: err });
    return results;
  }

  const topLevelData = res.data.data;
  if (!topLevelData) {
    const errMsgs = Array.isArray(res.data.errors) ? res.data.errors.map(e => e.message).join('; ') : 'no data returned';
    const err = new Error(`GraphQL batch file fetch returned no data: ${errMsgs}`);
    for (const probe of probes) results.set(probe.key, { error: err });
    return results;
  }

  const failedAt = new Set();
  if (Array.isArray(res.data.errors) && res.data.errors.length > 0) {
    console.warn(`GraphQL batch file fetch returned partial errors: ${res.data.errors.map(e => e.message).join('; ').slice(0, 500)}`);
    for (const error of res.data.errors) {
      failedAt.add(Array.isArray(error.path) ? error.path.slice(0, 2).join('.') : '*');
    }
  }

  for (const meta of probeMeta) {
    const repoData = topLevelData[meta.repoAlias];
    const field = repoData ? repoData[meta.fieldAlias] : undefined;
    if (field) {
      results.set(meta.key, {
        content: typeof field.text === 'string' ? field.text : null,
        exists: true,
        isBinary: field.isBinary === true
      });
    } else {
      const result = { content: null, exists: false, isBinary: false };
      if (failedAt.has('*') || failedAt.has(meta.repoAlias) || failedAt.has(`${meta.repoAlias}.${meta.fieldAlias}`)) {
        result.failed = true;
      }
      results.set(meta.key, result);
    }
  }

  return results;
}

// --- GRAPHQL REPOSITORY LABELS FETCH ---
async function fetchLabelPages(token, owner, name, labels, cursor, onCall) {
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

    const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables: { owner, name, after: cursor } }, 'application/vnd.github+json', { onAttempt: onCall });

    if (res.code !== 200 || !res.data?.data?.repository?.labels) {
      const cleanRaw = (res.raw || '').trim().slice(0, 200);
      throw new Error(`GraphQL label fetch failed (HTTP ${res.code}): ${cleanRaw}`);
    }

    const labelData = res.data.data.repository.labels;
    for (const node of labelData.nodes) {
      labels.add(node.name.toLowerCase());
    }
    hasNextPage = labelData.pageInfo.hasNextPage;
    cursor = labelData.pageInfo.endCursor;
  }
}

// Fetches all repository label names in one paginated GraphQL query, returning
// a Set of lowercased names for O(1) existence checks.
export async function graphqlFetchRepoLabels(token, repoFullname) {
  const slashIndex = repoFullname.indexOf('/');
  const owner = repoFullname.slice(0, slashIndex);
  const name = repoFullname.slice(slashIndex + 1);

  const labels = new Set();
  await fetchLabelPages(token, owner, name, labels, null);
  return labels;
}

// --- GRAPHQL PR SETUP FETCH ---
// Everything a pull_request event needs before validation starts, in one round
// trip: the repository's labels, .github/formalities.json, .github/labeler.yml,
// and when a pull request number is given, that pull request's commits and
// issue comments. Returns
// { labels, configText, labelerText, commits, commitsTotal, comments }. A
// missing file yields null text (callers fall back to defaults). `labels` may
// be null when paging past the first page failed; label bookkeeping is not
// worth failing the run over. `comments` is null when the thread is longer
// than one page, so the caller lists it through REST instead.
const COMMIT_FIELDS = `oid
          url
          message
          changedFilesIfAvailable
          author { name email user { login } }
          committer { name email user { login } }
          parents(first: 2) { totalCount }
          signature {
            isValid
            state
            signature
            ... on GpgSignature { keyId }
          }`;

export async function graphqlFetchRepoSetup(token, repoFullname, ref, configPath, labelerPath, onCall, prNumber = null, maxCommitPages = 3) {
  const slashIndex = repoFullname.indexOf('/');
  const owner = repoFullname.slice(0, slashIndex);
  const name = repoFullname.slice(slashIndex + 1);
  const withPr = Number.isInteger(prNumber);

  const query = `query($owner: String!, $name: String!, $cfgExpr: String!, $labExpr: String!${withPr ? ', $pr: Int!' : ''}) {
  repository(owner: $owner, name: $name) {
    labels(first: 100) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
    cfg: object(expression: $cfgExpr) { ... on Blob { text } }
    labeler: object(expression: $labExpr) { ... on Blob { text } }${withPr ? `
    pullRequest(number: $pr) {
      commits(first: 100) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { commit {
          ${COMMIT_FIELDS}
        } }
      }
      comments(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes {
          databaseId
          body
          authorAssociation
          viewerDidAuthor
          author { login __typename }
        }
      }
    }` : ''}
  }
}`;

  const variables = { owner, name, cfgExpr: `${ref}:${configPath}`, labExpr: `${ref}:${labelerPath}` };
  if (withPr) variables.pr = prNumber;
  const res = await githubApiCall(GRAPHQL_URL, token, 'POST', { query, variables },
    'application/vnd.github+json', { onAttempt: onCall });

  const repo = res.code === 200 ? res.data?.data?.repository : null;
  if (!repo) {
    const cleanRaw = (res.raw || '').trim().slice(0, 200);
    throw new Error(`GraphQL repository setup fetch failed (HTTP ${res.code}): ${cleanRaw}`);
  }

  let labels = new Set();
  for (const node of repo.labels?.nodes || []) {
    labels.add(node.name.toLowerCase());
  }
  const pageInfo = repo.labels?.pageInfo;
  if (pageInfo?.hasNextPage) {
    try {
      await fetchLabelPages(token, owner, name, labels, pageInfo.endCursor, onCall);
    } catch (err) {
      console.warn(`Repository label listing failed past the first page, continuing without it: ${err.message}`);
      labels = null;
    }
  }

  const setup = {
    labels,
    configText: typeof repo.cfg?.text === 'string' ? repo.cfg.text : null,
    labelerText: typeof repo.labeler?.text === 'string' ? repo.labeler.text : null,
    commits: null,
    commitsTotal: 0,
    comments: null
  };
  if (!withPr) return setup;

  const pr = repo.pullRequest;
  if (!pr) {
    throw new Error(`GraphQL repository setup fetch failed: pull request #${prNumber} not found in ${repoFullname}`);
  }

  const commits = (pr.commits?.nodes || []).map(node => restCommitFromGraphql(node.commit));
  setup.commitsTotal = pr.commits?.totalCount ?? commits.length;
  let commitsPage = pr.commits?.pageInfo;
  let pagesFetched = 1;
  while (commitsPage?.hasNextPage && pagesFetched < maxCommitPages) {
    const pageRes = await githubApiCall(GRAPHQL_URL, token, 'POST', {
      query: `query($owner: String!, $name: String!, $pr: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      commits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { commit {
          ${COMMIT_FIELDS}
        } }
      }
    }
  }
}`,
      variables: { owner, name, pr: prNumber, after: commitsPage.endCursor }
    }, 'application/vnd.github+json', { onAttempt: onCall });
    const page = pageRes.code === 200 ? pageRes.data?.data?.repository?.pullRequest?.commits : null;
    if (!page) {
      const cleanRaw = (pageRes.raw || '').trim().slice(0, 200);
      throw new Error(`GraphQL commit listing failed past page ${pagesFetched} (HTTP ${pageRes.code}): ${cleanRaw}`);
    }
    for (const node of page.nodes || []) commits.push(restCommitFromGraphql(node.commit));
    commitsPage = page.pageInfo;
    pagesFetched++;
  }
  setup.commits = commits;

  if (pr.comments && !pr.comments.pageInfo?.hasNextPage) {
    setup.comments = (pr.comments.nodes || []).map(restCommentFromGraphql);
  }
  return setup;
}

// GraphQL names a signature's outcome with an enum; the REST listing spelled
// the same states in lower case, which is what the commit checks print.
const SIGNATURE_REASONS = {
  MALFORMED_SIG: 'malformed_signature',
  UNKNOWN_SIG_TYPE: 'unknown_signature_type'
};

// Reshapes one GraphQL commit into the object the REST commits listing used to
// deliver - only the fields the checks read.
export function restCommitFromGraphql(commit) {
  const linked = (identity) => identity?.user?.login ? { login: identity.user.login } : null;
  const signature = commit.signature;
  const verification = signature
    ? {
      verified: signature.isValid === true,
      reason: SIGNATURE_REASONS[signature.state] || String(signature.state || '').toLowerCase(),
      signature: signature.signature ?? null,
      ...(signature.keyId ? { key_id: signature.keyId } : {})
    }
    : { verified: false, reason: 'unsigned', signature: null };
  return {
    sha: commit.oid,
    html_url: commit.url,
    parents: Array.from({ length: commit.parents?.totalCount ?? 1 }, () => ({})),
    author: linked(commit.author),
    committer: linked(commit.committer),
    changed_files: Number.isInteger(commit.changedFilesIfAvailable) ? commit.changedFilesIfAvailable : null,
    commit: {
      message: commit.message || '',
      author: { name: commit.author?.name || '', email: commit.author?.email || '' },
      committer: { name: commit.committer?.name || '', email: commit.committer?.email || '' },
      verification
    }
  };
}

// Reshapes one GraphQL issue comment into the REST shape the comment scan
// reads. GitHub Apps come back as `Bot` authors with a bare slug; REST spells
// them `<slug>[bot]`, which the bot-account rule looks for.
export function restCommentFromGraphql(node) {
  const isBot = node.author?.__typename === 'Bot';
  return {
    id: node.databaseId,
    body: node.body || '',
    author_association: node.authorAssociation || 'NONE',
    user: node.author ? { login: isBot ? `${node.author.login}[bot]` : node.author.login, type: isBot ? 'Bot' : 'User' } : null,
    viewer_did_author: node.viewerDidAuthor === true
  };
}

// Creates a repository label if it does not already exist. Returns true if
// created, false if it already existed. `existingLabels` may be null when the
// label listing could not be fetched: the create is then attempted blindly,
// with the 422 GitHub answers for an already-existing label silenced.
export async function ensureLabelExists(token, repoFullname, name, color, description, existingLabels, onCall) {
  if (existingLabels && existingLabels.has(name.toLowerCase())) return false;
  const url = `https://api.github.com/repos/${repoFullname}/labels`;
  const res = await githubApiCall(url, token, 'POST', { name, color: color || 'ededed', description: description || '' }, 'application/vnd.github+json', { silent: true, onAttempt: onCall });
  if (res.code === 422) {
    existingLabels?.add(name.toLowerCase());
    return false;
  }
  if (res.code >= 200 && res.code < 300) {
    existingLabels?.add(name.toLowerCase());
    return true;
  }
  // A failed create must not be recorded as existing, so a later attempt can
  // retry it.
  return false;
}

// Fallback for responses without the `user.permissions` object. The flat
// `permission` field only ever reports admin/write/read/none.
const WRITE_PERMISSION_LEVELS = ['admin', 'write'];

// Checks whether a user holds write access to a repository. Returns true/false
// when GitHub answered authoritatively (including 404, silenced as the normal
// "not a collaborator" answer) and null when the lookup itself failed, so
// callers can tell "no access" apart from "no answer".
export async function fetchUserRepoPermission(repoFullname, username, token, onCall) {
  if (!repoFullname || !username) return false;
  const url = `https://api.github.com/repos/${repoFullname}/collaborators/${encodeURIComponent(username)}/permission`;
  const res = await githubApiCall(url, token, 'GET', null, 'application/vnd.github+json', { silent: true, onAttempt: onCall });
  if (res.code === 404) {
    return false;
  }
  if (res.code !== 200 || !res.data) {
    return null;
  }
  const permissions = res.data.user?.permissions;
  if (permissions && typeof permissions === 'object') {
    return permissions.admin === true || permissions.maintain === true || permissions.push === true;
  }
  return WRITE_PERMISSION_LEVELS.includes((res.data.permission || '').toLowerCase());
}
