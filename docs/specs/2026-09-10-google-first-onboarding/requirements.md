# Google-first household onboarding

An invited household member should reach the permissions website without knowing
what Clerk is or finding account-connection settings. The operator should not
have to guide each person through an email-only account repair.

The owner requested this correction after invitation enrollment led to Clerk's
generic welcome page and a separate Manage account → Connected accounts detour.
The affected people are invited family members, returning users, and the operator
who invites them. All requirements below are owner-authorized, required for this
correction; no priority among them was specified.

## Needs and boundaries

- **U-ONB-01:** An invitation should lead directly to Google authentication and
  then our website. Basis: owner's request that invited users immediately go
  through Google, without the observed multi-screen detour.
- **U-ONB-02:** Existing email-invited users need a visible Google action on entry,
  not instructions to navigate Clerk account settings. Basis: owner's explicit
  request for the immediate button after the observed email-only enrollment.
- **U-ONB-03:** Preserve email invitations and restricted registration. Google
  supplies website identity; invitation possession must not silently become
  completed Google onboarding. Basis: owner retained invitations and Google-only
  login throughout the original setup.
- **U-ONB-04:** Website login must remain separate from each agent's Google API
  authorization. No Gmail/Drive scopes are granted by onboarding. Basis: existing
  accepted agent/account permission model and owner's separate-consent decision.
- **U-ONB-05:** Prove the actual visible flow and show screenshots of our UI.
  Basis: owner's screenshot and usable-family-onboarding requests.

Existing issuer/session validation, owner/editor configuration, per-agent account
policy, resource-token custody, and tailnet-only access remain authoritative.
This work may change the app's login UI, callback handling and related deployment
instructions. It must not create a new identity provider, bypass invitations,
relax network admission, redesign Google resource authorization, or modify
Gondolin. A separate PR starts from origin/master; unrelated work stays untouched.

## User journey

```text
Invited family member (U-ONB-01,03)
  Today: invitation -> email enrollment -> Clerk welcome -> account menu -> Google
  Target: invitation -> Continue with Google -> Google -> permissions website

Existing email-invited member (U-ONB-02)
  Today: signed in, but must discover Connected accounts
  Target: open website -> Connect Google to finish setup -> Google -> website

Both journeys (U-ONB-04)
  Website identity established != permission for an agent to use Gmail/Drive
```

See [Specification](specification.md) for observable behavior. Hosting/configuration
must be qualified separately from synthetic SDK tests; neither proves the other.
