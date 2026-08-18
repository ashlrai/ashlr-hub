# Quickstart — end-to-end walk-through

This guide takes you from a fresh clone to a dry-run preview and an optional
owner-invoked proposal in five steps. It does not activate a resident or
unattended fleet.

## Prerequisites

- **Node.js 22.15+** (`node --version` — install.sh enforces this minimum)
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

Key things it checks: config file present, Node version, and optional tool
availability (`phantom`, `claude`, `gh`, etc.). The production conductor loop
remains dormant independently because its compiled trust roots are empty.

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
ashlr enroll kill off   # disengage — does not activate the dormant loop
```

---

## Step 4 — Run a dry-run tick

`ashlr loop --dry-run` runs a single planning tick without producing any
proposals or touching any file. It prints what the fleet *would* do.

```sh
ashlr loop --dry-run
```

The production compiled conductor trust roots are empty, so non-dry `ashlr
loop` and `ashlr loop --watch` refuse before producing proposals. To create a
proposal through a live owner-invoked path, use one of:

```sh
ashlr goal "<objective>"  # plan + advance one bounded proposal-only milestone
ashlr run "<goal>"        # one owner-invoked run
ashlr swarm "<goal>"      # one owner-invoked multi-agent run
```

These commands do not grant resident or unattended loop authority.

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
