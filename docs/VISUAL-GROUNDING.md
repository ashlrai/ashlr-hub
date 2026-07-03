# Visual Grounding Roadmap

Ashlr Hub should treat visual grounding as a reusable perception layer, not as a
single-model feature. The primitive is:

```text
image or screenshot + natural-language target -> normalized boxes/points + evidence metadata
```

This unlocks better autonomous verification: agents can prove that a UI state,
document region, error banner, deploy control, or rendered component exists
without making Mason inspect every screenshot by hand.

## Current Implementation

- `src/core/visual/grounding.ts` defines a provider-neutral visual grounding API.
- `foundry.visualGrounding.enabled` defaults off.
- HTTP providers require an explicit endpoint and never run when disabled.
- Non-loopback endpoints are blocked unless `allowRemoteEndpoint:true`, because
  screenshots may contain customer data, source code, browser sessions, or
  secrets.
- `locateanything-http` additionally requires `licenseAccepted:true`, because
  NVIDIA's released LocateAnything-3B weights are non-commercial/research-use.
- Results store metadata only: normalized boxes, image byte count/hash/path, and
  scrubbed short model text. The API does not persist base64 images.

Example local research worker config:

```json
{
  "foundry": {
    "visualGrounding": {
      "enabled": true,
      "provider": "locateanything-http",
      "endpoint": "http://127.0.0.1:8000",
      "model": "nvidia/LocateAnything-3B",
      "licenseAccepted": true
    }
  }
}
```

## NVIDIA LocateAnything-3B

NVIDIA's LocateAnything-3B is a strong fit for Ashlr's perception layer because
it is built for visual grounding rather than general image chat. It supports GUI
grounding, document layout grounding, OCR localization, dense object detection,
referring-expression grounding, and point/box localization. NVIDIA describes its
main technical contribution as Parallel Box Decoding, which predicts box geometry
as an atomic unit and improves throughput while preserving localization quality.

Use it as a research backend and benchmark oracle first. Do not make it the
default commercial backend without license review.

Primary sources:

- NVIDIA project page: https://research.nvidia.com/labs/lpr/locate-anything/
- NVlabs Eagle repo: https://github.com/NVlabs/Eagle
- Hugging Face model card/license: https://huggingface.co/nvidia/LocateAnything-3B

## Best Ashlr Use Cases

1. Visual auto-merge evidence:
   Verify that a web app render, exported PDF, dashboard panel, or docs page
   contains the expected UI state before merge.

2. Browser and desktop action proposals:
   Keep DOM/accessibility selectors as the first choice, then use visual
   grounding when selectors fail or when the UI is only available through pixels.
   Visual grounding should propose click targets; it should not directly click.

3. Mission Control overlays:
   Show screenshots with boxes and short model rationale so autonomous work is
   auditable at a glance.

4. Deployment rescue:
   Let agents inspect GitHub/Vercel/Supabase/Railway dashboards, locate red
   status indicators or retry controls, extract evidence, and propose safe
   recovery steps.

5. Docs and Ashlr MD verification:
   Ground tables, broken diagrams, missing headings, screenshots, and export
   regions in generated docs/PDFs.

6. Visual eval loop:
   Track ScreenSpot-Pro-style grounding accuracy, VisualWebArena browser tasks,
   and OSWorld desktop tasks so Ashlr improves visual autonomy with measurable
   regressions and scorecards.

## Competitive Leverage

- Microsoft OmniParser is useful as a screen parser pattern, but its checkpoint
  licensing needs review before product embedding.
- UI-TARS and OS-Atlas are strong GUI-agent/grounding references; Ashlr should
  benchmark against them while differentiating on proposal-first safety,
  evidence packs, local-first execution, and auto-merge gates.
- Florence-2 and GroundingDINO are permissive fallback primitives for cheaper
  broad detection/grounding, but they are not full GUI agents.
- Browser Use is a practical browser harness, but Ashlr should keep compliance,
  domain allowlists, and evidence capture as first-class concerns.

## Next Patches

- Wire `VisualGroundingResult` into browser verification evidence so screenshots
  can carry boxes and image hashes.
- Add a read-only `ashlr_visual_locate` MCP tool only after the operator UX makes
  screenshot upload boundaries obvious.
- Add a proposal-only `ashlr_visual_click_proposal` tool that never clicks
  directly and records the proposed target box.
- Add provider adapters for OS-Atlas/Florence-2/GroundingDINO or an internal
  local worker once licensing and deployment paths are clear.
- Add a visual benchmark command that can run ScreenSpot-Pro-style fixtures.
