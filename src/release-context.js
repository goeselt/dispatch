'use strict'

// Pure helpers for interpreting the GitHub Actions ref/branch context. Shared by release.js (branch guards) and
// github-api.js (Latest-marker policy) so neither has to depend on the other.

// inferRefType derives the ref kind from a fully qualified ref name.
function inferRefType(ref) {
  if (ref?.startsWith('refs/heads/')) return 'branch'
  if (ref?.startsWith('refs/tags/')) return 'tag'
  if (ref?.startsWith('refs/pull/')) return 'pull_request'
  return ''
}

// branchNameFromRef returns the short branch name for a refs/heads/* ref, or an empty string otherwise.
function branchNameFromRef(ref) {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ''
}

// hasReleaseContext reports whether any GitHub event context was provided.
function hasReleaseContext(context = {}) {
  return Boolean(
    context.eventName || context.ref || context.refType || context.refName || context.defaultBranch || context.sha,
  )
}

module.exports = {
  branchNameFromRef,
  hasReleaseContext,
  inferRefType,
}
