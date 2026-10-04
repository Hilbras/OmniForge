/**
 * PEP 503 name normalisation.
 *
 * PyPI treats `Foo.Bar`, `foo_bar`, and `foo-bar` as the *same* project. Getting
 * this wrong means uploading to a name nobody looks for, or failing to find a
 * release that exists — so the rule lives in one place and is used by both the
 * client and the validation path.
 */

/**
 * Normalise a project name to its canonical form.
 *
 * Per PEP 503: lowercase, and runs of `-`, `_`, and `.` collapse to a single `-`.
 */
export function normalizePackageName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/**
 * The form used inside wheel and sdist filenames.
 *
 * Wheel names escape the canonical form by replacing `-` with `_`, so
 * `foo-bar` ships as `foo_bar`. Comparing a filename against the canonical form
 * without this produces a false mismatch on every hyphenated package.
 */
export function escapeFilenameName(name: string): string {
  return normalizePackageName(name).replace(/-/g, '_');
}

/**
 * Validate a project name.
 *
 * Returns a reason string, or null when the name is acceptable. The limits are
 * PyPI's: 200 characters overall and 64 for any dot-separated segment, because a
 * longer segment is rejected at upload time after the whole build has run.
 */
export function validatePackageName(name: string): string | null {
  if (name.length === 0) return 'Project name must not be empty.';
  if (name.length > 200) return `Project name is ${name.length} characters; PyPI allows 200.`;
  if (name !== name.trim()) return 'Project name must not begin or end with whitespace.';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return `Project name "${name}" contains characters PyPI does not allow.`;
  }
  for (const segment of name.split('.')) {
    if (segment.length > 64) {
      return `Segment "${segment}" is ${segment.length} characters; PyPI allows 64 per segment.`;
    }
  }
  return null;
}

/** True when two names refer to the same PyPI project. */
export function sameProject(a: string, b: string): boolean {
  return normalizePackageName(a) === normalizePackageName(b);
}
