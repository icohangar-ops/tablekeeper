# tools/shipscore — vendored factory tooling

This directory is **pre-existing infrastructure**, vendored from
[Team Dash's ShipScore](https://github.com/team-dash/shipscore) (MIT).

**Clean-room note:** the Dark Factory clean-room requirement applies to the
**product** (the tablekeeper clone in `app/`), which is written from scratch
during the build window by the agent band. This directory contains only the
CI quality gate the factory uses to *check its own results* — it predates the
event and is included verbatim, unmodified:

```
action.yml            # GitHub Action definition (threshold / categories / comment)
action/main.mjs       # standalone scanner runtime (node:fs + node:path only)
action/dist/cli.mjs   # bundled CLI
```

The workflow in `.github/workflows/shipscore-gate.yml` references it locally:

```yaml
- uses: ./tools/shipscore
  with:
    threshold: 60
```

No external action repo needs to exist for this to run — the gate works from
the very first push.
