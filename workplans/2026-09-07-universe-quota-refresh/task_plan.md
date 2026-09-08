# Fresh resource evidence for unattended Universe work

## Goal

Close the next verified unattended-operation gap using existing quota refresh,
capacity admission, campaign ownership and resource evidence patterns.

## Phases

- [x] Explore current refresh, generation, and capacity-wait contracts.
- [x] Select a compatible bounded increment and assign independent lanes.
- [x] Implement and verify normal, stale, refused, cancelled, and replay cases.
- [ ] Build, accept the exact local artifact, and publish verified source.

## Constraints

Preserve the original user checkout. No GitHub Actions, global configuration or
credential reads, live model/account calls, credential changes, downloads, or
resident activation. Tests use explicitly private inert fixtures. Do not infer
fresh quota from time passing or clear uncertain resource occupancy.

## Status

Bounded pre-generation metadata refresh, explicitly enabled by optional private
quotaConfigPath. Three implementation lanes: shared lease extraction, one-pass
refresh, independent native integration tests. Main integrates Universe and docs.
No long-lived shared invocation context or capacity retry is introduced.
