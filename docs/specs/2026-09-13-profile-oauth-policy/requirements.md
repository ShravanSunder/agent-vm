# Profile-owned OAuth policy requirements

Configuration authors need one complete Tool Portal profile to describe an agent role. Today ceilings are authored in OAuth agent entries while command profiles and agent policy defaults are in Tool Portal; named defaults also silently supply consent recommendations.

## Authorized needs

All rows are authorized by Shravan's configuration-boundary discussion in this session and final instruction “elts do it”. Priority is required for this bounded delivery, assigned by that instruction.

- U1 — Deployment authors can understand the role in one Tool Portal profile: commands, OAuth application references, ceilings, consent recommendations, and call-policy defaults.
- U2 — Authors can select named or explicit consent recommendations without those selections determining Deny/Ask/Allow policy.
- U3 — Agents select profiles; agents sharing a profile share configured policy. Different configured roles use different complete profiles without inheritance or per-agent overrides.
- U4 — Account owners retain separate actual consent and policy overrides for each agent/account/application. Existing enrollment, reauthorization, runtime enforcement, and one-call approvals remain effective.
- U5 — OAuth configuration retains application registrations, credentials, website and human admission. Deployment guidance clearly explains the hard cutover from old property locations.

## Boundary

This is configuration coherence plus custom consent recommendations, using existing Google/Gog support. It does not introduce new providers, catalog operations, account identities, VM behavior, profile inheritance, or credential distribution. Application references do not let configuration redefine command effects. No Gondolin or upstream Hermes changes. Existing security and proof requirements remain binding.

## User journeys

Author (U1–U3, U5): define OAuth registrations → define one role profile → assign agent → validate. Current pain is crossing two agent maps and the asymmetric collection/explicit schema; desired result is one profile policy definition with clear references.

Account owner (U4): open agent-provided private link → select consent → connect account → choose account policy. This journey and its account isolation remain unchanged.

No unresolved owner choices are recorded. Structural proof must verify that account storage and live-default inheritance can be preserved before implementation assumes it.
