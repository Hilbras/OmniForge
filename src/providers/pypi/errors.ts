/**
 * PyPI upload error normalisation.
 *
 * twine reports failures as free text on stderr. This turns that into typed
 * errors, so the user is told whether to fix a token, pick a different version,
 * or change the packaging — advice that sends them in opposite directions if
 * misclassified.
 *
 * The cases below are twine's actual messages, not invented ones.
 */

import {
  AuthError,
  CheckError,
  ConfigError,
  DuplicateReleaseError,
  ProviderError,
  ErrorCode,
} from '../../errors/index.js';
import type { ForgeError } from '../../errors/index.js';

/** Convert twine output into a typed error. */
export function normalizeUploadError(name: string, version: string, output: string): ForgeError {
  const text = output.toLowerCase();

  // Order matters. A duplicate on a scoped-name project can also mention auth, and
  // "your token is broken" is the wrong advice when the token is fine.
  if (
    text.includes('409') ||
    text.includes('file already exists') ||
    text.includes('same file') ||
    text.includes('already been taken')
  ) {
    return new DuplicateReleaseError(`${name} ${version} is already on PyPI.`, {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation:
        'PyPI does not allow re-uploading a file name. Choose a higher version — a new upload needs new filenames.',
      detail: { package: name, version },
    });
  }

  if (
    text.includes('invalid or non-existent authentication token') ||
    text.includes('401 client error') ||
    text.includes('please access the pypi api') ||
    text.includes('username or password') ||
    text.includes('username/password')
  ) {
    return new AuthError(ErrorCode.AUTH_FAILED, `PyPI rejected the credential for ${name}.`, {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation:
        'Check PYPI_TOKEN, and that the token is scoped to the project. PyPI tokens begin "pypi-".',
      detail: { package: name, output: output.trim().slice(0, 400) },
    });
  }

  if (
    text.includes('403') ||
    text.includes('not permitted') ||
    text.includes('insufficient privileges') ||
    text.includes('does not have permission')
  ) {
    return new AuthError(ErrorCode.AUTH_FAILED, `The token cannot upload ${name}.`, {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation:
        'A project-scoped token uploads only to its own project. Manage tokens at pypi.org/manage/account/token/.',
      detail: { package: name, output: output.trim().slice(0, 400) },
    });
  }

  // A filename PyPI rejects is a packaging bug, and twine reports it as a 400 with
  // a message worth showing verbatim.
  if (text.includes('400') || text.includes('invalid distribution') || text.includes('filename')) {
    return new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `PyPI rejected the distributions for ${name}.`,
      {
        provider: 'pypi',
        operation: 'pypi.upload',
        remediation:
          'Check the project name and version in pyproject.toml. Filenames must match the name and version.',
        detail: { package: name, version, output: output.trim().slice(0, 600) },
      },
    );
  }

  if (text.includes('no files found') || text.includes('no distribution files')) {
    return new ProviderError(ErrorCode.PROVIDER_FAILED, 'There was nothing to upload.', {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation: 'Build first: `forge pypi build`.',
      detail: { package: name },
    });
  }

  // twine reports a broken or non-network repository URL as an
  // UnreachableRepositoryURLDetected rather than a connection error. Worth naming,
  // because the fix is a configuration change and not a retry.
  if (
    text.includes('unreachablerepositoryurldetected') ||
    text.includes('invalid repository url') ||
    text.includes('no supported repositories')
  ) {
    return new ConfigError(
      ErrorCode.CONFIG_INVALID,
      'The configured PyPI repository URL is not usable.',
      {
        provider: 'pypi',
        operation: 'pypi.upload',
        remediation:
          'Check pypi.repository in forge.config.yaml. It must be an https URL twine can reach — for example https://upload.pypi.org/legacy/.',
        detail: { package: name, repository: output.trim().slice(0, 300) },
      },
    );
  }

  // twine itself failed to start — a missing dependency, or an environment where a
  // stale `packaging` shadows the one twine needs. Retrying cannot fix this, and
  // "run twine upload --verbose" would not tell the user what is actually wrong.
  if (
    text.includes('modulenotfounderror') ||
    text.includes('importerror') ||
    text.includes('traceback (most recent call last)') ||
    text.includes('no module named')
  ) {
    return new CheckError(ErrorCode.CHECK_FAILED, 'twine could not start.', {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation:
        'twine failed before uploading anything — usually an incomplete install, or a stale PYTHONPATH shadowing its dependencies. Run `twine --version` and fix that first.',
      detail: { package: name, output: output.trim().slice(-800) },
    });
  }

  return new ProviderError(
    ErrorCode.PROVIDER_FAILED,
    `Upload to PyPI failed for ${name} ${version}.`,
    {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation: 'Run `twine upload --verbose` yourself to see twine’s full output.',
      detail: { package: name, version, output: output.trim().slice(0, 800) },
    },
  );
}
