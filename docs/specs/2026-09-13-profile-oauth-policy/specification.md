# Profile-owned OAuth policy specification

[Requirements](requirements.md) → this contract → [Program Design](program-design.md).

## Observable configuration boundary

```text
Deployment author -- OAuth registrations + Tool Portal profiles --> Agent VM
Account owner ----- private consent/policy website ---------------> Agent VM
Agent ------------- assigned tools + account lifecycle requests --> Agent VM
Google ------------ consent and resource authorization ----------> Agent VM
```

OAuth configuration is connection and human-access setup; Tool Portal profiles are agent-role policy. Accounts are not deployment-authored slots.

## Obligations

- R1 (U1, U3): Managed Tool Portal profiles own `oauthApplications`, keyed by registered application ID. Each entry requires `ceiling`; `consentRecommendation` and `policyDefaults` are independently optional. Agents use their selected profile, with no profile inheritance or agent-level override map.
- R2 (U2): `consentRecommendation` accepts a named collection (`kind: collection`, `collectionId`, `version`) or explicit `groupIds`. Omitted recommendation means no preselection. It must not grant consent or change call policy.
- R3 (U1, U2): `policyDefaults` accepts a named collection or explicit `services` with existing read/write deny/ask/allow dispositions. Omitted rules retain deny fallback. Recommendations do not derive from these dispositions.
- R4 (U1, U5): OAuth configuration contains no authored agent policy map. Tool Portal agent entries reject old `googlePolicyDefaults`; old OAuth `agents` is rejected. Human admission references are validated against agents having profile-declared OAuth applications.
- R5 (U1, U4): Every reachable OAuth command requires a matching profile application declaration. Unknown references, foreign-family groups, duplicate groups, unknown collection/version, excessive recommendations/defaults, or reachable commands exceeding a ceiling fail validation rather than clamp permissions. Existing code-owned command classification remains authoritative.
- R6 (U4): Compiled profile recommendations initialize new enrollment selections. Existing account consent remains owner-controlled; account overrides remain agent/account/application-specific. Sharing a profile shares no accounts. Runtime calls continue to enforce commands, maximum, consent, effective policy, and one-call approval.
- R7 (U4): Defaults remain live for inherited account cells; explicit overrides remain independent. Recommendation-only changes do not change the effective defaults revision. Existing configuration-change fencing and publication behavior remain intact.
- R8 (U5): Examples and generated deployment guidance explain the two-file boundary, profile sharing, independent recommendation/default selection, and replacement of old locations. There is no compatibility path or automatic deployment mutation.

## Accepted forms

```json
{
  "oauthApplications": {
    "gmail-app": {
      "ceiling": { "kind": "catalog-preset", "presetId": "all-supported" },
      "consentRecommendation": { "kind": "explicit", "groupIds": ["gmail.read"] },
      "policyDefaults": {
        "kind": "explicit",
        "services": { "gmail": { "read": "allow", "write": "deny" } }
      }
    }
  }
}
```

A named collection resolves only the field in which it appears and only the application's catalog family. Missing application policy never implies all-supported. Config authors must declare intended ceilings.

## Proof coverage

| Need / problem | Outcome / contract | Evidence |
| --- | --- | --- |
| U1, U3: scattered role definition | R1, R4, R5: complete, validated profile | Schema/compiler behavior and valid/invalid CLI configuration transcripts |
| U2: custom consent absent | R2, R3: independent named/explicit inputs | Compiler outputs and enrollment preselection through real broker wiring |
| U4: preserve account authority | R6, R7: same consent, overrides, runtime decisions | Account-state inspection and existing authorization/approval integration scenarios |
| U5: safe author migration | R8: one authored authority | Generated-manual CLI output and migrated examples validated against current schema |

Malformed configuration fails before OAuth startup side effects. No new retries, provider interactions, storage lifecycles, or UI layouts are required by this change.
