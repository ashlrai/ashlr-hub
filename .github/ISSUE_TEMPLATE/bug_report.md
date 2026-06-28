---
name: Bug report
about: Report something that isn't working as expected
title: "[Bug]: "
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behavior:

1. Run `...`
2. With config `...`
3. See error

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include any error output.

```
<paste output here>
```

## Fleet / autonomous loop context

If the bug involves the autonomous operator, please fill in:

- **Kill-switch state** (`ashlr enroll list` — is the kill switch on?): 
- **Engine / model in use** (from `ashlr doctor` or `~/.ashlr/config.json`): 
- **Relevant log entries** (tail of `~/.ashlr/audit/` or `~/.ashlr/logs/`):

```
<paste relevant log lines here>
```

- **`ashlr doctor` output**:

```
<paste ashlr doctor output here>
```

## Environment

- ashlr-hub version: <!-- output of `ashlr --version` -->
- Node.js version: <!-- output of `node --version` -->
- OS: <!-- e.g. macOS 15.5, Ubuntu 24.04 -->
- Install method: <!-- install.sh / npm install -g @ashlr/hub / source -->

## Additional context

Add any other context about the problem here (logs, screenshots, related commands).
