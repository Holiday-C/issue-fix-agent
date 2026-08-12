# Security Policy

Issue Fix Agent executes model-proposed operations against source repositories. Treat unexpected filesystem access, command execution, credential exposure, permission bypasses, sandbox escapes, and unsafe default policies as security issues.

## Reporting

Do not open a public Issue for a suspected vulnerability. Use GitHub private vulnerability reporting through the repository's **Security → Advisories → Report a vulnerability** page. Repository maintainers should enable private vulnerability reporting when the remote repository is published.

Include:

- affected commit or version;
- impact and required preconditions;
- a minimal reproduction using synthetic data;
- suggested mitigation, if known.

Never include real API keys, private repository contents, credentials, or personal information.

## Supported Versions

Until the first stable release, only the latest commit on `main` receives security fixes.

## Disclosure

Please allow time to reproduce and fix a report before public disclosure. A project maintainer will coordinate attribution and disclosure timing with the reporter.
