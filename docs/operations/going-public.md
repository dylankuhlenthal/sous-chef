# Going public

How the core repo goes from private to public, once, with `main` protected from the start. Files: `.github/workflows/ci.yml` (the check), `.github/rulesets/main.json` (the branch rule), `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`. Why the decision records were cleaned first: decision 0030 (the one-off scrub). Why install is a one-line pipe: decision 0032.

Making the repo public, its GitHub settings and the owner's own account settings are outward-facing, so the maintainer does them, or says go for an agent to run the commands. Only the maintainer merges.

## Before: what must already be true

- Porch is public and on npm, and `package.json` takes it from there (decision 0033, Porch comes from npm). Without that, a stranger's `npm ci` and CI's both fail: neither can read a private GitHub repo.
- The PR that adds this runbook has a green `tests` check (`.github/workflows/ci.yml`), which is the first run of the suite on Linux.

## Steps, in order

Do them in this order. The repo must be public before the ruleset can be applied: GitHub refuses rulesets and branch protection on a private repo on a free plan (it answers 403).

1. **Maintainer: merge the PR.**
2. **Maintainer: GitHub email settings.** In GitHub's Settings, Emails, turn on "Keep my email addresses private" and "Block command line pushes that expose my email". New commits in the core use the GitHub no-reply address (`git config user.email` in the core's checkout, already set). Older commits keep the address they were made with; history is not rewritten, because that would change every commit id and the `last-python` tag.
3. **Maintainer: make the repo public.**

   ```sh
   gh repo edit dylankuhlenthal/sous-chef --visibility public --accept-visibility-change-consequences
   ```

4. **On the maintainer's go, an agent or the maintainer applies the settings below**, then reads each one back.

   The branch ruleset on `main`: the `tests` check must pass, changes arrive through a pull request (no approvals needed, since there is one maintainer), and force pushes and deleting `main` are refused, with nobody allowed to bypass it.

   ```sh
   gh api -X POST repos/dylankuhlenthal/sous-chef/rulesets --input .github/rulesets/main.json
   gh api repos/dylankuhlenthal/sous-chef/rulesets   # one ruleset named "main", enforcement "active"
   ```

   Secret scanning, push protection (GitHub refuses a push that contains a secret it recognises), private vulnerability reporting (`SECURITY.md` points reporters at it) and Dependabot alerts (notifications about known-vulnerable dependencies; no automatic pull requests):

   ```sh
   gh api -X PATCH repos/dylankuhlenthal/sous-chef \
     -f 'security_and_analysis[secret_scanning][status]=enabled' \
     -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
   gh api -X PUT repos/dylankuhlenthal/sous-chef/private-vulnerability-reporting
   gh api -X PUT repos/dylankuhlenthal/sous-chef/vulnerability-alerts
   gh api repos/dylankuhlenthal/sous-chef --jq .security_and_analysis
   gh api repos/dylankuhlenthal/sous-chef/private-vulnerability-reporting   # {"enabled": true}
   gh api repos/dylankuhlenthal/sous-chef/vulnerability-alerts && echo enabled   # 204 when on, 404 when off
   ```

   Repo metadata, and deleting a pull request's branch when it merges. Issues stay on; Projects, the wiki and discussions are off (the maintainer tracks work elsewhere):

   ```sh
   gh repo edit dylankuhlenthal/sous-chef \
     --description "An agent that tracks your work and launches and manages Claude Code background sessions for you." \
     --add-topic claude-code,ai-agents,developer-tools,typescript \
     --enable-issues --enable-projects=false --enable-wiki=false --enable-discussions=false \
     --delete-branch-on-merge
   gh repo view dylankuhlenthal/sous-chef --json description,repositoryTopics,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled,hasDiscussionsEnabled,deleteBranchOnMerge
   ```

5. **Agent: check the one-line install from the real URL**, into temporary folders so nothing real is touched. This is the first time the raw file URL can be checked: it answers only for a public repo, and only once the change is on `main`.

   ```sh
   t=$(mktemp -d)
   curl -fsSL https://raw.githubusercontent.com/dylankuhlenthal/sous-chef/main/install.sh |
     SOUS_CHEF_DIR="$t/core" bash -s -- --data "$t/data" --bin-dir "$t/bin" --name Sam --branch-prefix sam/ --no-git --yes
   "$t/core/bin/sc" owner     # owner: Sam, permission mode auto
   rm -rf "$t"
   ```

## The first owner's own install

The first owner's sous chef ran in `bypass` through a constant (decision 0015); it is now their setting, `auto` when unset (decision 0031). After the merge, update the live core with the step in `docs/operations/running.md` ("The build, and updating after a pull"), then straight away, before any `souschef --new`:

```sh
sc owner set --chef-permissions bypass
sc owner      # sous chef's own permission mode: bypass
```

The running sous chef keeps the mode it was started with until a `souschef --new`, so this changes nothing until then; it makes sure the next new sous chef starts in `bypass` rather than `auto`.
