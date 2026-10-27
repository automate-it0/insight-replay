---
name: 🐛 Bug report
about: Something isn't working as expected
title: "[bug] <short description>"
labels: ["bug", "needs-triage"]
assignees: []
---

## 🐛 Bug report

### What happened?

<!-- A clear and concise description of what the bug is. -->

### What did you expect to happen?

<!-- A clear and concise description of what you expected. -->

### Steps to reproduce

1. Go to '...'
2. Click on '...'
3. See error

### Environment

- **Insight Replay version**: <!-- e.g. 0.7.1 — check package.json -->
- **Runtime**: <!-- Bun / Node / Docker -->
- **OS**: <!-- macOS / Linux / Windows / WSL -->
- **Browser** (for dashboard issues): <!-- Chrome 120 / Firefox 121 / Safari 17 -->
- **Node version**: <!-- `node --version` -->
- **Bun version**: <!-- `bun --version` -->

### Logs / screenshots

```
Paste relevant logs here. Redact any secrets (API keys, tokens, IPs).
```

<!-- Attach screenshots if it's a UI issue. -->

### Tracking SDK (if applicable)

- **Tracked site URL**: <!-- https://example.com -->
- **SDK version**: <!-- check `window.InsightReplay.version` in the console -->
- **Browser**: <!-- Chrome 120 / Firefox 121 / Safari 17 -->
- **Sample `<script>` tag**: <!--
  <script src="https://your-insight-replay-host/api/track/script.js?pid=…" data-project-id="…" async></script>
-->

### What have you tried?

<!-- Tell us what you already attempted so we don't suggest it again. -->

- [ ] Read the [USAGE.md](./USAGE.md) troubleshooting section
- [ ] Checked existing issues for duplicates
- [ ] Tried with `NODE_ENV=production` (if relevant)
- [ ] Confirmed the dev server is reachable (`curl http://localhost:3000/api/health`)

### Would you be willing to submit a PR?

- [ ] Yes, I have time.
- [ ] Yes, but I'd need a pointer to the right file.
- [ ] No, sorry.
