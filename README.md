# EasySB Bot Worker

A GitHub App webhook engine running on **Cloudflare Workers** that keeps pull
requests in the [EasySBTeam](https://github.com/EasySBTeam) repositories up to
the conventions written down in `CONTRIBUTING.md` and `AGENTS.md`: conventional
commit subjects, feature branches cut from `master`, a linear history, no
co-author trailers, and clean text files. It reports every result as a GitHub
check run, keeps one self-updating comment on the pull request, and applies the
`not following guidelines` label when a check fails.

The design follows
[openwrt/openwrt-bot-worker](https://github.com/openwrt/openwrt-bot-worker):
the same Cloudflare Worker shape, the same GraphQL-batched setup fetch, the same
subrequest budget, and the same self-editing comment. The rules themselves are
EasySB's, not OpenWrt's.

## What it checks

### FormalityCheck / Git & Commits

- **Branch target.** A pull request must not originate from a protected branch
  (`master` or `main`). A maintainer can waive this with `[allow branch]` (or
  `[allow-branch]`) in the description or in a comment. See
  [Who counts as a maintainer](#who-counts-as-a-maintainer).
- **Conventional commit subjects.** Every non-merge commit must read
  `type(scope): subject`, with the type one of `build`, `chore`, `ci`, `docs`,
  `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`. The scope is
  the module name and the description may be Chinese.
- **Linear history.** Merge commits inside the pull request are rejected;
  rebase onto `master` instead.
- **Subject hygiene.** No trailing period, a blank line before the body, and
  soft (72) and hard (100) length limits, counted in Unicode code points.
- **Description body.** `feat`, `fix`, `perf` and `refactor` require a body that
  is more than trailers; a body of only `Signed-off-by:` lines explains nothing.
- **Trailers.** Co-author trailers are rejected. The sign-off check is off by
  default and can be enabled per repository.
- **Autosquash and revert.** `fixup!`/`squash!` commits are deferred to the
  squash, and the exact `Revert "..."` subject `git revert` produces is accepted
  without a type.

### FormalityCheck / File Hygiene

- **Line endings.** Added lines must be LF; a CRLF file is reported.
- **Trailing newline.** A file that ends without a newline is reported.

> [!IMPORTANT]
> **A green check never means "not checked".** When a pull request is too large
> for the available API budget - the commit scan capped, or the diff
> unavailable - a check that found no problems reports GitHub's `neutral`
> conclusion titled *Partially checked* instead of a pass. `neutral` does not
> block the pull request; it only stops the bot from claiming it inspected
> something it never fetched. A check that found real problems still fails.

## Automated triage

- **`not following guidelines`** is added when any check fails and removed once
  a push makes every check pass.
- **Path labels** from `.github/labeler.yml` (the same v5 shape as
  `actions/labeler`) are added to a pull request that touches a matching path.
  Labels from this file are only ever added.
- **Stale cleanup** is a daily scheduled scan. When a repository opts in with
  `"enable_stale_bot": true`, pull requests carrying `not following guidelines`
  are marked `stale` after 14 days without activity and closed after another 14.
  Only contributor activity resets the countdown: pushed commits, force-pushes,
  reopens, and comments or reviews from people. Comments from GitHub Apps,
  `*[bot]` accounts and the machine accounts in `stale_ignored_users` are
  ignored.

## Repository configuration

Every value can be overridden by committing `.github/formalities.json` on the
repository's default branch. The bot reads it from the default branch, never
from the pull request head, so a pull request cannot switch off the checks that
judge it.

```json
{
  "check_signoff": true,
  "max_subject_len_soft": 72,
  "enable_stale_bot": true,
  "stale_ignored_users": ["easysb-ci"]
}
```

The full set of keys and their defaults lives in
`cloudflare-worker/src/config.js`. Only the keys a repository wants to change
need to be present; the rest fall back to the defaults.

## Who counts as a maintainer

An override command is honored when the comment author holds write access. The
bot trusts `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`) first and
falls back to a repository permission lookup for maintainers whose organization
membership is private. Bots never count, whatever access they hold.

## Deployment

### Creating the GitHub App

GitHub has no API to create an App, so creation goes through the manifest flow,
which needs one browser confirmation from an organization owner. The worker
serves that flow so it is a single click:

1. Open `https://<worker-hostname>/setup/github-app` while logged in as an
   organization owner. The page posts a manifest to GitHub; confirm on the
   GitHub page that follows.
2. GitHub redirects back to the worker's callback page with a short-lived code.
   Exchange that code for the app's credentials with
   `POST https://api.github.com/app-manifests/{code}/conversions` and store the
   returned `id`, `pem` and `webhook_secret` on the worker.
3. Install the app on the organization:
   `https://github.com/apps/<app-slug>/installations/new`.

The two `/setup/github-app` routes stop answering once `APP_ID` is configured,
so nothing stays open after setup.

### Manual configuration

The worker needs a GitHub App with these repository permissions:

- **Checks:** read and write
- **Issues:** read and write
- **Pull requests:** read
- **Metadata:** read

Subscribe the app to the **Pull request** event and point its webhook URL at
`https://<worker-hostname>/webhook`. Set the webhook secret and the app's
private key as Worker secrets:

```bash
# The App ID is a plain variable, the other two are secrets.
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put PRIVATE_KEY
```

`APP_ID` is read from `env.APP_ID`; add it as a Worker variable or secret.
Then deploy:

```bash
cd cloudflare-worker
npx wrangler deploy
```

The `Deploy webhook to Cloudflare Worker` workflow runs the test suite and a
`wrangler deploy --dry-run` on every push to `main`, then deploys through the
`production` environment. Set `CLOUDFLARE_API_TOKEN` as a repository secret.

## Local development

```bash
cd cloudflare-worker

# Run the unit and integration tests.
npm test

# Check the bundle without deploying.
npx wrangler deploy --dry-run
```

Every rule in `src/validators.js` is a pure function, so the checks are tested
without any network access. The webhook handler is exercised end to end with a
mocked GitHub API in `test/index.test.js`.

## Layout

```text
cloudflare-worker/
  src/
    index.js        webhook entrypoint, orchestration, check-run writes
    validators.js   the EasySB formality and diff-hygiene rules
    github.js       GitHub REST/GraphQL helpers with retry and budget hooks
    crypto.js       GitHub App JWT signing and webhook HMAC verification
    labeler.js      .github/labeler.yml parser and glob matcher
    stale.js        the daily scheduled stale-PR scan
    config.js       default configuration and label constants
  test/             node --test suites
```

## License

GPL-3.0, matching the rest of the EasySBTeam projects.
