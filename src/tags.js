'use strict'

const TAG_HELP = 'Use a simple tag such as v1.2.3, v1, or v1.2.'

// Tag validation

function hasAsciiControlOrWhitespace(value) {
  return [...value].some((ch) => {
    const code = ch.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
}

function validateTagName(tag, name = 'tag') {
  if (!tag) throw new Error(`${name} is required`)
  if (tag !== tag.trim()) throw new Error(`${name} must not have leading or trailing whitespace. ${TAG_HELP}`)
  if (hasAsciiControlOrWhitespace(tag)) {
    throw new Error(`${name} must not contain whitespace or control characters. ${TAG_HELP}`)
  }
  if (tag.startsWith('-')) throw new Error(`${name} must not start with -. ${TAG_HELP}`)
  if (tag.startsWith('/') || tag.endsWith('/') || tag.includes('//')) {
    throw new Error(`${name} must be a valid tag name. ${TAG_HELP}`)
  }
  if (tag.includes('..')) throw new Error(`${name} must not contain "..". ${TAG_HELP}`)
  if (tag.includes('@{') || tag === '@') throw new Error(`${name} must be a valid tag name. ${TAG_HELP}`)
  if (/[~^:?*[\]\\{}]/.test(tag)) {
    throw new Error(`${name} contains characters that are not allowed in git tags. ${TAG_HELP}`)
  }
  if (tag.endsWith('.') || tag.endsWith('.lock')) throw new Error(`${name} must be a valid tag name. ${TAG_HELP}`)
  for (const part of tag.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) {
      throw new Error(`${name} must be a valid tag name. ${TAG_HELP}`)
    }
  }
  return tag
}

function validateOptionalTagName(tag, name) {
  if (!tag) return ''
  return validateTagName(tag, name)
}

function semanticVersionParts(tag) {
  const match = /^(v?)(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag)
  if (!match) return null
  return {
    prefix: match[1],
    major: match[2],
    minor: match[3],
  }
}

function validateFloatingTags(inputs) {
  if (!inputs.majorTag && !inputs.minorTag) return

  const version = semanticVersionParts(inputs.releaseTag)
  if (!version) {
    throw new Error('major-tag and minor-tag require a semantic release-tag such as v1.2.3.')
  }

  const expectedMajor = `${version.prefix}${version.major}`
  const expectedMinor = `${version.prefix}${version.major}.${version.minor}`

  if (inputs.majorTag && inputs.majorTag !== expectedMajor) {
    throw new Error(`major-tag must be ${expectedMajor} for release-tag ${inputs.releaseTag}, got ${inputs.majorTag}.`)
  }
  if (inputs.minorTag && inputs.minorTag !== expectedMinor) {
    throw new Error(`minor-tag must be ${expectedMinor} for release-tag ${inputs.releaseTag}, got ${inputs.minorTag}.`)
  }
}

module.exports = {
  TAG_HELP,
  semanticVersionParts,
  validateFloatingTags,
  validateOptionalTagName,
  validateTagName,
}
