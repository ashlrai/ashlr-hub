# Quickstart — end-to-end walk-through

This guide takes you from a fresh clone to your first autonomous proposal in
five steps. Every command here is copy-pasteable and has been verified against
the real CLI.

## Prerequisites

- **Node.js 22+** (`node --version` — must be v22 or later; install.sh enforces this)
- **git** on your `PATH`
- A repo you are comfortable experimenting with

---

## Step 1 — Install

Clone and run the installer. It builds `dist/`, symlinks `bin/ashlr` into
`~/.local/bin`, and smoke-tests `ashlr help`.

```sh
git clone https://github.com/ashlrai/ashlr-hub.git
cd ashlr-hub
./install.sh
```

If `~/.local/bin` is not on your `PATH`, the installer will tell you. Add it:

```sh
# add to ~/.zshrc or ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
source ~/.zshrc   # or source ~/.bashrc
```

Verify the install:

```sh
ashlr --version
ashlr help
```

---

## Step 2 — Health check

Run `ashlr doctor` to confirm your environment is wired up correctly before
enrolling anything.

```sh
ashlr doctor
```

Key things it checks: config file present, Node version, optional tool
availability (`phantom`, `claude`, `gh`, etc.). None of the optional tools are
required to run the autonomous loop — they extend it.

---

## Step 3 — Enroll a repo

Only enrolled repos ever receive autonomous work. Nothing happens to a repo
until you explicitly add it here.

```sh
# See what is currently enrolled (starts empty)
ashlr enroll list

# Enroll a repo by absolute path
ashlr enroll add /path/to/your/repo
```

To remove a repo later:

```sh
ashlr enroll remove /path/to/your/repo
```

To engage the kill switch (halts all autonomous work immediately across every
enrolled repo):

```sh
ashlr enroll kill on    # engage — everything stops
ashlr enroll kill off   # disengage — resumes on next tick
```

---

## Step 4 — Run a dry-run tick

`ashlr loop --dry-run` runs a single planning tick without producing any
proposals or touching any file. It prints what the fleet *would* do.

```sh
ashlr loop --dry-run
```

When you are ready to produce real proposals (they land in the Approval Inbox —
nothing is applied until you approve):

```sh
ashlr loop
```

To run continuously, watching for changes:

```sh
ashlr loop --watch
```

---

## Step 5 — Review and approve proposals

Proposals are never applied automatically. They sit in the Approval Inbox until
you act on them.

```sh
# List pending proposals
ashlr inbox

# Inspect a specific proposal (shows the diff + rationale)
ashlr inbox show <id>

# Approve a proposal (applies the diff to a new branch in your repo)
ashlr inbox approve <id>

# Reject a proposal
ashlr inbox reject <id>
```

---

## Confirm the safety model is intact

At any time you can self-check the live safety invariants (5 structural checks):

```sh
ashlr verify-safety
```

All 5 should pass on a clean install. See `SECURITY.md` for a full description
of each guarantee.

---

## What's next

- `ashlr help` — full command reference
- `CONTRIBUTING.md` — dev setup, conventions, safety invariants
- `SECURITY.md` — responsible-disclosure + the safety model in detail
- `docs/ARCHITECTURE.md` — module map and autonomous loop internals
- `examples/plugins/` — examples for extending ashlr-hub with plugins
