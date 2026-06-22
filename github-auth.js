'use strict'

// Scopes a GitHub token to the individual git/gh commands that need it.
// The token is passed only through the spawned child's environment for a single command; it is never written
// to process.env or to .git/config, so it cannot leak into downstream workflow steps or persist on disk.

// withMergedEnv layers env on top of the current process environment without mutating process.env.
// The result is meant for a single child command's options.env only.
function withMergedEnv(options, env) {
  return { ...options, env: { ...process.env, ...(options.env || {}), ...env } }
}

function needsGitHubToken(name, args) {
  if (name === 'gh') return true
  if (name !== 'git') return false
  return ['fetch', 'ls-remote', 'push'].includes(args[0])
}

// gitAuthEnv builds a request-scoped HTTP Basic auth header for the GitHub remote.
// git has no token concept, so the token is injected as an `http.<url>.extraheader` through git's environment-based
// config (GIT_CONFIG_COUNT, requires git >= 2.31).
// This keeps the token out of the command line and out of .git/config.
//
// We reset both the URL-specific and the generic `http.extraheader` with an empty value (which clears a multi-value
// list) before appending ours, so a credential the checkout persisted under either key cannot ride along as a second,
// conflicting Authorization header. Stored config is never modified; the reset is request-scoped.
//
// The entries are appended after any GIT_CONFIG_* already present in the environment (git reads indices
// 0..GIT_CONFIG_COUNT-1), so we never overwrite or shadow config the runner injected through these variables.
// GIT_TERMINAL_PROMPT=0 makes a too-old git fail fast instead of hanging on a credential prompt.
function gitAuthEnv(token) {
  const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(/\/+$/, '')
  const urlKey = `http.${serverUrl}/.extraheader`
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

  const existing = Number.parseInt(process.env['GIT_CONFIG_COUNT'] || '0', 10)
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0

  const entries = [
    ['http.extraheader', ''],
    [urlKey, ''],
    [urlKey, header],
  ]

  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(base + entries.length),
  }
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key
    env[`GIT_CONFIG_VALUE_${base + i}`] = value
  })
  return env
}

function githubHost() {
  const serverUrl = process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  return new URL(serverUrl).hostname
}

function ghAuthEnv(token) {
  const host = githubHost()
  if (host === 'github.com') return { GH_TOKEN: token }
  return { GH_HOST: host, GH_ENTERPRISE_TOKEN: token }
}

// withGitHubToken wraps exec so that gh receives the token for the active GitHub host and git network commands receive the
// request-scoped extraheader, while all other commands run with an unmodified environment.
// Returns fn(exec) unchanged when no token is configured.
function withGitHubToken(exec, token, fn) {
  if (!token) return fn(exec)

  const authenticatedExec = (name, args, options = {}) => {
    if (!needsGitHubToken(name, args)) return exec(name, args, options)
    if (name === 'gh') return exec(name, args, withMergedEnv(options, ghAuthEnv(token)))
    return exec(name, args, withMergedEnv(options, gitAuthEnv(token)))
  }

  return fn(authenticatedExec)
}

module.exports = {
  ghAuthEnv,
  gitAuthEnv,
  needsGitHubToken,
  withGitHubToken,
}
