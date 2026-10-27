---
name: 🔒 Security report
about: Report a security vulnerability (public issues are auto-routed; for sensitive reports, follow SECURITY.md)
title: "[security] <short description>"
labels: ["security", "needs-triage"]
assignees: []
---

## ⚠️ Important — read first

For **sensitive security reports** (anything that would let an attacker read
someone else's recordings, bypass auth, or escalate privileges), **do not
open a public issue**. Follow the responsible-disclosure policy in
[SECURITY.md](./SECURITY.md) — open a **GitHub Private Security Advisory**
at <https://github.com/automate-it0/insight-replay/security/advisories/new>.
The maintainer (`@automate-it0`) is notified automatically.

This template is for **non-sensitive** security questions or hardening
suggestions that don't expose an exploitable path.

## 🔒 Security report

### What's the issue?

<!-- A clear and concise description of the security concern. -->

### Where in the code?

<!-- File paths + line numbers if you have them. -->

### Attack scenario

<!-- Walk us through the steps an attacker would take. -->

1. Attacker does X
2. Server responds with Y
3. Attacker gains Z

### Impact

- **Confidentiality**: <!-- recordings / IPs / visitor data exposure? -->
- **Integrity**: <!-- can data be modified? -->
- **Availability**: <!-- can the service be denied? -->
- **Privilege escalation**: <!-- can a user gain admin access? -->

### Proposed fix

<!-- What would close this hole? -->

### Environment

- **Insight Replay version**:
- **NODE_ENV**: <!-- development / production -->
- **Feature flags**: <!-- list any FF_* flags set to "false" -->

### Checklist

- [ ] I have read [SECURITY.md](./SECURITY.md).
- [ ] This is not a sensitive vulnerability that should be reported privately.
- [ ] I have redacted any PII, secrets, or live URLs from this report.
