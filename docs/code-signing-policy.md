# Code signing policy

For official Windows releases after the application is approved: **Free code
signing provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).** Current Windows
continuous-integration artifacts remain unsigned until that approval.

## Scope

This policy applies to official Windows executables and installers published
by the Codex Taskboard project. Development builds, pull-request artifacts,
and local builds are not signed.

## Team roles

- Authors and committers: [@jadon7](https://github.com/jadon7) and
  [@chuspeeism](https://github.com/chuspeeism).
- Reviewers: [@jadon7](https://github.com/jadon7) and
  [@chuspeeism](https://github.com/chuspeeism). Changes from other
  contributors are reviewed through pull requests before merge.
- Approver: repository owner
  [@chuspeeism](https://github.com/chuspeeism). Every signing request requires
  manual approval.

## Build and approval

- Signing inputs must come from the public repository and a GitHub-hosted
  Actions workflow. Artifacts built on a developer computer are not eligible.
- The source revision and workflow run must be recorded for each signed
  artifact.
- A project maintainer must review the release changes and manually approve
  every signing request.
- Signing roles must use individual accounts with multi-factor authentication.
  Signing credentials must not be stored in the repository or workflow logs.
- A signed artifact must be published without modification after signing.

## Privacy

Codex Taskboard's data handling and network activity are documented in the
[Privacy policy](../PRIVACY.md).

## Incident response

If a signing credential or signed artifact is suspected to be compromised,
maintainers stop signing and distribution, preserve the related workflow and
artifact records, notify the signing provider, and request certificate
revocation when required. A replacement release is built from a reviewed
source revision after the incident is resolved.

Security reports should use the repository's private vulnerability-reporting
channel. Non-sensitive signing questions can use the public issue tracker.
