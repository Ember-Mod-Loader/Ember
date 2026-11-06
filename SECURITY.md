# Security

Security fixes target the newest stable Ember release. Use the latest published version when reporting an issue.

For a suspected vulnerability, use this repository's **Security → Report a vulnerability** option when private reporting is available. If it is unavailable, open an issue asking for a private contact route without posting the exploit or sensitive details publicly.

Do not include access tokens, private profile codes, real configuration secrets, user data folders, or full personal file paths in a public report. A synthetic reproduction, affected version, expected behavior, and a concise description of the boundary involved are useful.

The app downloads executable mod code that runs when the game launches. Package archive validation does not establish that a mod is trustworthy. Third-party mods and game compatibility are outside Ember's own code security guarantees.

The distributed client reads public release metadata without GitHub credentials. Repository maintainers control releases, workflow changes, and update delivery. Keep maintainer accounts protected, review changes to workflows and the configured update provider carefully, and keep signing credentials in approved secret storage rather than the repository.
