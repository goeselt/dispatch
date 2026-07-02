'use strict'

// Minimal GitHub REST client built on the global fetch (Node >= 20). It replaces the GitHub CLI for the three
// release operations this action performs (auth check, release lookup, release creation with asset upload).
//
// Why REST and not gh: gh resolves which token to send from its own host classification (github.com vs *.ghe.com vs
// GitHub Enterprise Server). That classification is the layer that rejected the automatic GITHUB_TOKEN on Enterprise
// with "HTTP 401: Must authenticate to access this API". Actions always exports GITHUB_API_URL pointing at the correct
// REST base for the active host, so we target it directly with an explicit `Authorization: Bearer <token>` header and
// avoid host guessing entirely.

const fs = require('node:fs')
const path = require('node:path')

const { branchNameFromRef, hasReleaseContext } = require('./release-context.js')

// Configuration

const ASSET_CONTENT_TYPE = 'application/octet-stream'

// GitHub rejects API requests without a User-Agent header (HTTP 403); Node's global fetch does not send an identifying
// one. GitHub recommends the application name. https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
const USER_AGENT = 'open-dispatch'

// Transient-failure handling. Release actions are network-heavy and reruns are expensive, so we retry transient
// failures with exponential backoff, mirroring the retry/throttling plugins that established release actions rely on.
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 500
// Upper bound on a single backoff. It caps a hostile or buggy Retry-After (e.g. "Retry-After: 999999") so it cannot
// stall the run for an unbounded time.
const RETRY_MAX_DELAY_MS = 60_000
// Statuses retried for any method. 429 and 503 mean the request was not applied. 500/502/504 are ambiguous for POST
// (the write may have been applied server-side); the residual risk is a duplicate release, which fails with 422 for an
// already-published tag and otherwise leaves a duplicate draft visible in the releases UI.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
// Methods whose retry is safe after an ambiguous network failure. POST is excluded: a dropped connection might have
// created a release or asset server-side, and a blind retry would duplicate it.
const RETRYABLE_NETWORK_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH'])

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// retryDelayMs computes exponential backoff with jitter and never waits less than a Retry-After header (seconds) the
// server supplied (used by GitHub for rate and secondary-rate limits). The result is capped at RETRY_MAX_DELAY_MS so a
// hostile or buggy Retry-After cannot stall the run.
function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number.parseInt(retryAfterHeader ?? '', 10)
  const headerMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 0
  const backoff = RETRY_BASE_MS * 2 ** (attempt - 1)
  const jitter = Math.floor(Math.random() * RETRY_BASE_MS)
  return Math.min(RETRY_MAX_DELAY_MS, Math.max(headerMs, backoff + jitter))
}

// URL helpers

// apiBaseUrl returns the REST API base for the active GitHub host without a trailing slash.
// It fails closed when GITHUB_API_URL is missing rather than defaulting to api.github.com: every request carries the
// token in an Authorization header, and silently falling back to the public host would transmit an Enterprise token to
// github.com. Actions always exports GITHUB_API_URL for the active host, so the variable is only absent when the action
// runs outside its supported environment.
function apiBaseUrl() {
  const url = process.env['GITHUB_API_URL']
  if (!url) {
    throw new Error(
      'GITHUB_API_URL is not set; refusing to send the token to a default host. Run dispatch in GitHub Actions.',
    )
  }
  return url.replace(/\/+$/, '')
}

// repoPath splits "owner/name" and percent-encodes each segment for safe interpolation into a URL path.
function repoPath(repo) {
  const [owner, name, ...rest] = String(repo || '').split('/')
  if (!owner || !name || rest.length > 0) {
    throw new Error(`invalid repository ${JSON.stringify(repo)}; expected owner/name`)
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

// Authenticated request with retry

// request issues an authenticated REST call. It returns { status, body } where body is parsed JSON when the response
// carries a JSON content type, otherwise the raw text. A non-2xx status throws unless it is listed in allowStatuses,
// so callers can treat an expected 404 (no release for a tag) as data rather than an error.
//
// Transient failures (retryable HTTP statuses for any method, plus network/timeout failures for idempotent methods) are
// retried up to DEFAULT_MAX_ATTEMPTS times with exponential backoff. timeoutMs aborts a stalled request so the retry can
// take over; pass 0 to disable it for long-running transfers such as asset uploads. onRetry, when provided, is called
// before each backoff with { method, status, attempt, maxAttempts, delayMs } so callers can surface that a retry is
// happening (status is null for a network failure).
async function request(token, method, url, options = {}) {
  const { body, headers, allowStatuses = [], timeoutMs = DEFAULT_TIMEOUT_MS, sleep = defaultSleep, onRetry } = options

  // scheduleRetry waits out one backoff and notifies onRetry; status is null for a network-level retry.
  const scheduleRetry = async (attempt, status, retryAfterHeader) => {
    const delayMs = retryDelayMs(attempt, retryAfterHeader)
    onRetry?.({ method, status, attempt, maxAttempts: DEFAULT_MAX_ATTEMPTS, delayMs })
    await sleep(delayMs)
  }

  for (let attempt = 1; ; attempt++) {
    let res
    try {
      const init = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          ...headers,
        },
        body,
      }
      if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs)
      res = await fetch(url, init)
    } catch (err) {
      // Network failure or timeout before any response. Retrying is only safe for idempotent methods; a POST might have
      // been applied server-side, so it fails fast to avoid a duplicate release or asset.
      if (RETRYABLE_NETWORK_METHODS.has(method) && attempt < DEFAULT_MAX_ATTEMPTS) {
        await scheduleRetry(attempt, null, null)
        continue
      }
      throw new Error(`${method} ${url}: ${err.message}`, { cause: err })
    }

    const text = await res.text()
    let parsed = text
    if (text && (res.headers.get('content-type') || '').includes('application/json')) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!res.ok && !allowStatuses.includes(res.status)) {
      // A Retry-After header (rate or secondary-rate limit, even on a 403) marks an otherwise non-retryable status as
      // retryable and sets the minimum wait.
      const retryAfter = res.headers.get('retry-after')
      const retryable = RETRYABLE_STATUSES.has(res.status) || retryAfter != null
      if (retryable && attempt < DEFAULT_MAX_ATTEMPTS) {
        await scheduleRetry(attempt, res.status, retryAfter)
        continue
      }
      const detail = parsed && parsed.message ? parsed.message : typeof parsed === 'string' ? parsed.trim() : ''
      throw new Error(`${method} ${url}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
    }
    return { status: res.status, body: parsed }
  }
}

// Release policy

// makeLatestField maps the action's make-latest policy to the REST `make_latest` enum. It always returns one of
// "true" / "false" / "legacy":
//   true            -> mark as Latest
//   false           -> never Latest
//   auto            -> let GitHub decide by date/semver (REST "legacy")
//   default-branch  -> auto on the default branch, never Latest elsewhere
function makeLatestField(options = {}) {
  const makeLatest = options.makeLatest || 'default-branch'
  if (makeLatest === 'true') return 'true'
  if (makeLatest === 'false') return 'false'
  if (makeLatest === 'auto') return 'legacy'

  const context = options.releaseContext || {}
  if (!hasReleaseContext(context)) return 'legacy'

  const refName = context.refName || branchNameFromRef(context.ref || '')
  const defaultBranch = context.defaultBranch || ''
  if (defaultBranch && refName && refName === defaultBranch) return 'legacy'
  return 'false'
}

// REST client

// createClient binds a token to the release operations. Methods take the repository as "owner/name" because the REST
// API has no remote-inference fallback the way gh did. The token is only validated when a method is actually called,
// so a create-release:false run (which performs no API calls) does not require one.
// requestOptions (retry/timeout/sleep) are forwarded to every request, which keeps the retry policy injectable for
// tests.
function createClient(token, requestOptions = {}) {
  const call = (method, url, opts = {}) => request(token, method, url, { ...requestOptions, ...opts })

  // uploadAsset uploads a single file to a release. assetPath must be absolute (callers resolve it against the
  // workspace that validated it, so the read base matches the validation base). upload_url is an RFC 6570 template such
  // as "https://uploads.<host>/.../assets{?name,label}"; GitHub returns it already pointing at the correct uploads
  // host, so we only strip the template suffix and append the file name. The body is the raw file bytes. The per-request
  // timeout is disabled because a large asset can legitimately take longer than a control-plane call.
  async function uploadAsset(uploadUrl, assetPath) {
    const base = uploadUrl.replace(/\{[^}]*\}$/, '')
    const name = path.basename(assetPath)
    const data = fs.readFileSync(assetPath)
    await call('POST', `${base}?name=${encodeURIComponent(name)}`, {
      headers: { 'Content-Type': ASSET_CONTENT_TYPE },
      body: data,
      timeoutMs: 0,
    })
  }

  // checkAuth verifies the token can read the repository, failing fast before any tag is pushed.
  async function checkAuth(repo) {
    await call('GET', `${apiBaseUrl()}/repos/${repoPath(repo)}`)
  }

  // getReleaseByTag returns { exists, url, isDraft }. A 404 means no release is attached to the tag and must not be
  // confused with an auth or network failure, which would let the action recreate an existing release.
  async function getReleaseByTag(repo, tag) {
    const { status, body } = await call(
      'GET',
      `${apiBaseUrl()}/repos/${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`,
      { allowStatuses: [404] },
    )
    if (status === 404) return { exists: false, url: '' }
    return { exists: true, url: body.html_url || '', isDraft: Boolean(body.draft) }
  }

  // createRelease creates the release for an already-pushed tag, uploads assets, and returns the release URL.
  // When assets are present the release is created as a draft, assets are uploaded, then it is published. This mirrors
  // the gh draft->upload->publish flow: with release immutability enabled, assets cannot be added after publish.
  // When an upload or the publish fails, the draft is deleted (best-effort) before rethrowing: the by-tag lookup only
  // returns published releases, so a leftover draft would be invisible to a rerun -- drafts with partial assets would
  // accumulate, and a maintainer could publish one by mistake.
  async function createRelease(repo, tag, assets = [], options = {}) {
    const base = `${apiBaseUrl()}/repos/${repoPath(repo)}`
    const draft = assets.length > 0
    const payload = {
      tag_name: tag,
      draft,
      generate_release_notes: true,
      make_latest: makeLatestField(options),
    }

    const created = await call('POST', `${base}/releases`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const release = created.body
    if (!draft) return release.html_url || ''

    try {
      for (const asset of assets) {
        await uploadAsset(release.upload_url, asset)
      }
      const published = await call('PATCH', `${base}/releases/${release.id}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false }),
      })
      return published.body.html_url || release.html_url || ''
    } catch (err) {
      try {
        await call('DELETE', `${base}/releases/${release.id}`)
      } catch {
        // Cleanup is best-effort; the original failure is what the user must see.
      }
      throw err
    }
  }

  // getTagVerification returns the host's signature verification for an annotated tag object, e.g.
  // { verified: false, reason: 'no_user' }. tagSha is the tag object OID (`git rev-parse <tag>^{tag}`). It lets the
  // caller report whether a signed tag will show as verified, without changing the release.
  async function getTagVerification(repo, tagSha) {
    const { body } = await call('GET', `${apiBaseUrl()}/repos/${repoPath(repo)}/git/tags/${encodeURIComponent(tagSha)}`)
    return body.verification || {}
  }

  return { checkAuth, getReleaseByTag, createRelease, getTagVerification }
}

module.exports = {
  apiBaseUrl,
  createClient,
  makeLatestField,
  repoPath,
  request,
  retryDelayMs,
}
