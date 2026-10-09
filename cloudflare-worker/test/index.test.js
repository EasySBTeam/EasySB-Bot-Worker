import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import worker from '../src/index.js';
import { buildCommentBody } from '../src/index.js';

test('the comment summary names exactly one outcome', () => {
  const base = { commitResult: { errors: [], warnings: [], commitScanCapped: false }, hygieneResult: { errors: [], warnings: [] } };

  const passed = buildCommentBody({ ...base, failed: false, warnings: [] });
  assert.match(passed, /All checks pass\./);
  assert.doesNotMatch(passed, /Some checks failed/);
  assert.doesNotMatch(passed, /suggestions are noted/);

  const warned = buildCommentBody({ ...base, failed: false, warnings: [{ sha: 'abcdef1', message: 'x' }] });
  assert.match(warned, /suggestions are noted/);
  assert.doesNotMatch(warned, /Some checks failed/);

  const failed = buildCommentBody({ ...base, failed: true, warnings: [{ sha: 'abcdef1', message: 'x' }] });
  assert.match(failed, /Some checks failed/);
  assert.doesNotMatch(failed, /suggestions are noted/);
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'webhook-secret';
const APP_ID = '123';

function signedRequest(body, { event = 'pull_request', secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  return new Request('https://bot.example/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': signature,
      'content-type': 'application/json',
    },
    body: raw,
  });
}

function pullRequestPayload() {
  return {
    action: 'opened',
    installation: { id: 99 },
    repository: {
      full_name: 'EasySBTeam/EasySB',
      default_branch: 'master',
    },
    pull_request: {
      number: 7,
      body: 'A change.',
      head: { sha: 'abc123', ref: 'feat/tui' },
      base: { ref: 'master' },
    },
  };
}

// A router that answers the handful of GitHub endpoints one webhook run
// touches. It records every URL so a test can assert what was written.
function installFetchMock() {
  const calls = [];
  const setupCommit = {
    oid: 'abc123',
    url: '',
    message: 'feat(tui): 新增面板\n\n展示节点状态。',
    changedFilesIfAvailable: 1,
    author: { name: 'Dev', email: 'dev@example.com', user: { login: 'dev' } },
    committer: { name: 'Dev', email: 'dev@example.com', user: { login: 'dev' } },
    parents: { totalCount: 1 },
    signature: null,
  };
  const setupData = {
    data: {
      repository: {
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        cfg: { text: null },
        labeler: { text: null },
        pullRequest: {
          commits: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ commit: setupCommit }] },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  };

  globalThis.fetch = async (url, options = {}) => {
    const href = typeof url === 'string' ? url : url.toString();
    calls.push({ url: href, method: options.method || 'GET' });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    const text = (body, status = 200) => new Response(body, { status });

    if (href.includes('/app/installations/99/access_tokens')) return json({ token: 'installation-token' });
    if (href === 'https://api.github.com/graphql') return json(setupData);
    if (href.includes('/pulls/7') && options.headers?.Accept === 'application/vnd.github.v3.diff') {
      return text('diff --git a/internal/tui/view.go b/internal/tui/view.go\n--- a/internal/tui/view.go\n+++ b/internal/tui/view.go\n@@ -1 +1 @@\n-old\n+new\n');
    }
    if (href.includes('/labels/')) return text('', 200);
    if (href.includes('/check-runs')) return json({ id: 1 });
    if (href.includes('/issues/7/comments')) return json({ id: 2 });
    return json({});
  };
  return calls;
}

test('a bad signature is rejected with 403', async () => {
  installFetchMock();
  const res = await worker.fetch(signedRequest(pullRequestPayload(), { secret: 'wrong' }), { APP_ID, PRIVATE_KEY, WEBHOOK_SECRET: SECRET });
  assert.equal(res.status, 403);
});

test('a non-pull_request event is acknowledged without side effects', async () => {
  const calls = installFetchMock();
  const res = await worker.fetch(signedRequest({ action: 'created' }, { event: 'issues' }), { APP_ID, PRIVATE_KEY, WEBHOOK_SECRET: SECRET });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('a clean pull request passes and reports two check runs', async () => {
  const calls = installFetchMock();
  const res = await worker.fetch(signedRequest(pullRequestPayload()), { APP_ID, PRIVATE_KEY, WEBHOOK_SECRET: SECRET, SUBREQUEST_BUDGET_LIMIT: '45', SUBREQUEST_RESERVE_HEADROOM: '15' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Processed check runs for PR #7/);

  const checkRunCalls = calls.filter(c => c.url.includes('/check-runs'));
  assert.equal(checkRunCalls.length, 2);
});

test('the setup page posts a manifest to the organization', async () => {
  const res = await worker.fetch(new Request('https://easysb-bot.example.workers.dev/setup/github-app'), {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /organizations\/EasySBTeam\/settings\/apps\/new/);
  assert.match(html, /name="manifest"/);
  assert.match(html, /easysb-bot\.example\.workers\.dev\/webhook/);
});

test('the setup routes disable themselves once APP_ID is set', async () => {
  const res = await worker.fetch(new Request('https://easysb-bot.example.workers.dev/setup/github-app'), { APP_ID });
  assert.equal(res.status, 400);
});

test('the callback echoes the returned code', async () => {
  const res = await worker.fetch(new Request('https://easysb-bot.example.workers.dev/setup/github-app/callback?code=abc123&state=x'), {});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /abc123/);
});
