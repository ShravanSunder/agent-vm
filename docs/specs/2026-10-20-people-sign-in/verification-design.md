# People sign-in: Verification Design

[Requirements](requirements.md) · [Specification](2026-10-20-people-sign-in.md) · [Program Design](program-design.md)

This is the plan for showing that people's sign-in does what the [Specification](2026-10-20-people-sign-in.md) requires. **Nothing here has been run or observed.** Every target property below describes a build that does not exist yet.

**Before any row can pass, the owner must grant:**
- a Cloudflare test account where the test deployments run (prerequisite P1 in the build plan);
- Google and GitHub test OAuth apps;
- four test identities:
  - an owner Google account, used as the deployment's `ownerEmail`;
  - a Google account the owner will allowlist;
  - a GitHub account with the same verified email as that Google account;
  - a second Google account that is never listed.

No `verify-*` skill exists in this repository, so every journey below is `needed`. The plan builds them under a new `verify-auth` skill.

## What will prove each need

| Need | In plain words | Proven by | Stays unverified |
| --- | --- | --- | --- |
| `U1` | Sign in with Google, GitHub or a passkey, and nothing else | On the test deployment, sign in with each provider and with a passkey, and land on the same person each time. A well-formed attempt through any other method creates nothing. A second provider with the same email is refused until it is linked on purpose. The stored logins hold no Google or GitHub tokens. | real people's devices and browsers beyond the one used |
| `U2` | Only people the owner approved get into private apps | A fresh deployment admits only the owner first. An unlisted account is turned away and nothing is stored. After the owner removes someone, their passkey, their old browser session, their tokens and their pending Accept all fail. That includes requests caught halfway when the removal lands. | how long the hosted database takes to make a removal visible everywhere (only the local runtime holds steps in order) |
| `U3` | Public apps let anyone register | Register on the public deployment, then show its proof being refused by the private deployment's Tool Portal. | runs when the public deployment is built. Building private first is the Lead's proposal, waiting on the owner (`SD2`) |
| `U4` | Each service gets proof that works only for itself | The console's proof is refused by Tool Portal, and Tool Portal's is accepted. A proof with two audiences, or one that doesn't stand for a person, is refused. | the real console (a scripted stand-in calls instead) |
| `U5` | Runs on the owner's Cloudflare with its own database, no vendor | Read the deployment settings and the deployed Worker's own record: the owner's account, a database of its own, and no sign-in vendor in the code. | Workers Free CPU fit (`SD6`), measured separately |
| `U6` | Machines and VMs never use people's sign-in | The VM test lanes run with no sign-in service present. No machine is registered as a sign-in client, and no machine package depends on the sign-in package. | VPN and Router traffic through Cloudflare, which live outside this repository |
| `U7` | Every change to who may sign in, or how, is recorded, with no secrets | Make each kind of change, then read the audit table: one record per change, with who, what and when. A change whose record can't be written doesn't happen. Search the table and the Worker's logs for the real codes, tokens and cookies seen during the run; none appear. | how long records are kept (Tool Portal D6) |

## Targets

| Id | What | Used for |
| --- | --- | --- |
| `T1` | The private test deployment: the `@agent-collaboration/auth` Worker at the delivered commit, deployed to the owner's Cloudflare test account with its own D1 (read replication off), `mode: "private"`, the test OAuth apps, and `ownerEmail` set to the owner test account | every journey |
| `T2` | The public test deployment: the same commit, `mode: "public"`, its own Worker and D1 | `U3`, when built |
| `T3` | The same Worker build on a local Workers runtime with a local D1 | held interleavings and forced audit-write failures. Not hosted proof: it keeps Better Auth, the hooks, the request handler and the database statements real, but not D1's replication |
| `T4` | Tool Portal at the slice that delivers `decide`, using the production person-proof verifier configured to trust `T1` | decisions, audiences, freshness |
| client | A scripted stand-in for the console: a registered client that runs authorization code with S256 PKCE | asking for proofs. It stands in until the console exists, and it is never counted as console proof |

## Shared observations

Each observation is described once; the rows below say which obligations it decides.

**H. Owner bootstrap** (`verify-auth` `bootstrap`, needed, lasting). Starts from a freshly deployed `T1` with an empty D1.
- **Steps:**
  1. The allowlisted-later Google account tries to sign in.
  2. The owner signs in with Google.
  3. The never-listed Google account tries.
  4. The owner opens the admin surface.
- **Read:** each outcome; `deployment_owner`; the seeded `allowed_email` row; the `owner-bound` audit record.

**A. Provider sign-in** (`verify-auth` `provider-sign-in`, needed, lasting). On `T1` after H, in a real browser.
- **Steps:**
  1. The owner adds the listed address.
  2. That address signs in with Google.
  3. The unlisted Google account tries.
  4. The GitHub account with the same verified email tries.
  5. The listed person signs in with Google and links GitHub from the account page, by redirect.
  6. They sign out, then sign in with GitHub.
  7. While signed in, a request uses the ID-token form of `/link-social`.
  8. A well-formed attempt goes through each method that isn't offered: email sign-in, email sign-up, magic link, generic OAuth and anonymous.
- **Read:**
  - the screen and response for each step;
  - the D1 `user`, `account`, `session`, `allowed_email` and `sign_in_audit` rows, through read-only queries, including the token columns of every `account` row.
- **Human step:** Google's and GitHub's own login screens may need a person. The script pauses there and records who completed the step.

**B. Passkey** (`verify-auth` `passkey`, needed, lasting). A scripted browser with a virtual WebAuthn authenticator, on `T1`.
- **Steps:**
  1. Person A, signed in, registers a passkey, signs out and signs back in with it.
  2. Try to register a passkey with no session (`SD7` default).
  3. Try to sign in with a passkey that was deleted.
- **Read:** the session's user id in D1, compared with Person A's id from journey A.

**C. Proofs across services** (`verify-auth` `proof-audience`, needed, lasting). The stand-in client obtains four tokens from Person A's session on `T1`:
- one for the console's resource;
- one for Tool Portal's;
- one for Tool Portal's that also asks for `openid`;
- one that names both resources.

Each token goes to `T4`'s control API `explain` and to the verifier. **Read:** the verifier's result kind and reason, and Tool Portal's response. When `T2` exists, a `T2` token goes to `T4` too.

**D. Removal and sign-out** (`verify-auth` `removal`, needed, lasting). On `T1` and `T4`.
- **Setup:** Person A holds a Google browser session and a second browser's passkey session. A also holds a Tool Portal token taken before removal, and a pending proposal in `T4`. A copy of each session cookie is kept.
- **Act:** the owner removes A through the admin surface.
- **Attempt:**
  - a passkey sign-in;
  - a new token from each kept session cookie;
  - Accept with the earlier token;
  - introspection of that token;
  - with each kept cookie: passkey registration, consent, linking, unlinking, and an admin call.
- **Read:**
  - each refusal;
  - the E8 `removedAt`;
  - that no `session` row remains for A;
  - that no new `passkey`, `account` or consent row appears;
  - the audit records;
  - the proposal's state in `T4`.
- **Re-add:** the owner re-adds A's address. A signs in again and reaches the same Person id. The audit shows `reactivatedPersonId`.
- **Sign-out branch:** Person B signs out. Then request a new token with B's old cookie, and introspect B's earlier token.
- **Owner branch:** the owner removes their own entry. Their next admin call is refused.

**E. Held interleavings** (automated integration on `T3`, no journey). The test's composition can hold a request at a named step while the removal batch, or a sign-out, commits on another request. Each case is a separate run:
1. A passkey sign-in held after its session insert, before the final check. **Expect:** refused; no session row for A.
2. The same sign-in held after the final check, before the response leaves. **Expect:** the session reaches the browser, but the removal has deleted its row, so the next request with it fails.
3. A Google sign-in held before its session insert. **Expect:** refused at the final check.
4. A token request held after signing, before the final check. **Expect:** `invalid_grant`, and no token reaches the client.
5. The same, with a sign-out committing instead of a removal. **Expect:** `invalid_grant`.
6. A token request held after the final check. **Expect:** the token reaches the client; introspection of it is inactive; its `exp` is within `SD3`.
7. Introspection held after Better Auth's own `sid` read, before the final check. **Expect:** `{ active: false }`.
8. Introspection held after the final check. **Expect:** `active` with a `checkedAt` before the removal.
9. A first Google sign-in held after Better Auth wrote its user and account rows, before the current-person check binds the entry, while the owner removes that entry. **Expect:** refused. Read back the `user`, `account`, `allowed_email` binding, `session` and `sign_in_audit` rows: the user and account remain, unbound, with no session. A later re-add reactivates that same Person.
10. The same hold on the owner's first sign-in on an empty deployment, while a second, never-listed account tries. **Expect:** exactly one `deployment_owner` row naming the owner, and one `owner-bound` record.

**Read:** each response, and D1's `session`, OAuth code and token rows. A build whose only checks run before the effect fails cases 1, 4, 5 and 7. A build that binds in a user-creation hook fails case 9's readback.

**F. Decision freshness** (Tool Portal integration at the `decide` slice, no journey). Run on `T4`'s `decide` with the production verifier calling `T3`, under a controlled clock:
1. the live check passes, then the apply is held past `SD8`;
2. the same, with a removal landing in between;
3. an apply within `SD8` with no removal.

**Read:** whether the apply changed state, and whether a second live check was made, measured at the apply.

**G. Focused rules** (unit, no journey):
- *The verifier's token rules*, with real JOSE signing over test keys. Each of these must give its own reason: wrong `typ`, bad signature, wrong `iss`, an `aud` that is another service, an `aud` array containing this service (from `openid` and from two resources), expired, and `sid` missing. A token that is correct in every way verifies.
- *The allowlist gate:*
  - **email rule**, over the profile shapes Better Auth's Google and GitHub mappers produce: verified and listed matches, with case ignored; unverified never matches; removed never matches;
  - **derived active state:** bound and allowed is active; removed is inactive; re-added is active again.

**I. Audit coverage** (`verify-auth` `audit`, needed, lasting; plus forced failures on `T3`).
- **On `T1`:**
  - make each change kind `R12` lists: add and remove an allowlist entry; re-add; register, update and retire a client and a relying service; add and remove a passkey; link and unlink a login. The owner binding comes from H.
  - Export `sign_in_audit` and tail the Worker's logs for the run. Search both for every code, access token, session cookie, passkey credential id and public key captured during A–D and I.
- **On `T3`:**
  - make the before-change audit write fail during a passkey registration and during a link; no `passkey` or `account` row may appear;
  - make the outcome write fail after a change; the before-change record must still be there;
  - make an allowlist batch fail; neither the change nor its record may land.

## Rows

### `U1` — sign in with Google, GitHub or a passkey only

- **Obligations:** `R1`, `R2`, `R8`, and the Specification's privacy obligation · proof obligations `V1`, `V6` · seams: Program Design trace rows R1, R2, R8.
- **Proven by:** observations A and B, and the account-row read in A.
- **Reference:** Spec C1 steps 2–4; `R1`'s list of three methods; `R8`'s "link it from your account" outcome; the privacy list in the Specification's cross-cutting obligations.
- **Target and journey:** `T1`; `provider-sign-in` and `passkey`, both lasting.
- **Passes when:**
  - each provider sign-in and the passkey sign-in end with a session whose user id equals Person A's;
  - each well-formed attempt through another method creates no `user`, `account` or `session` row and sets no session cookie, whatever status it answers;
  - the configuration enables only the Google and GitHub providers and the passkey and OAuth-provider plugins;
  - before linking, the GitHub attempt shows the link message and D1 gains no `user` or `account` row;
  - after linking by redirect, a GitHub sign-in reaches Person A;
  - the ID-token linking form is refused and adds no `account` row;
  - passkey registration with no session is refused;
  - every `account` row has null access-token, refresh-token and ID-token columns, after first sign-in, repeat sign-in and linking;
  - an `account` row seeded with token values before a repeat sign-in has those columns null afterwards.

  Wrong builds that fail it:
  - email-and-password left enabled (an attempt creates a user or sets a session);
  - implicit linking on (a GitHub `account` row appears before linking);
  - a passkey sign-in that creates a second user;
  - Better Auth's default account persistence (token columns are filled).

  A correctly configured build whose core email routes answer with their "disabled" error passes.
- **Reuses:** none.
- **Unverified:** browsers and authenticators other than the one used; real hardware passkeys (a virtual authenticator stands in).

### `U2` — only approved people get into private apps

- **Obligations:** `R3`, `R4`, `R9`, `R13`, `R14` · proof obligations `V2`, `V3`, `V10` · seams: trace rows R3, R4, R9, R13, R14.
- **Proven by:**
  - H for the owner bootstrap;
  - A for an unlisted account;
  - D for removal, re-add, the late-cookie routes and sign-out;
  - E for requests caught halfway;
  - F for decision freshness;
  - G for the gate's rules.
- **Reference:** Spec C1 setup and steps 2 and 6; `R4`'s cutoff ("takes effect when it is recorded"); `R9`'s `SD8` bound; `R13`; `R14`; the Specification's failure table.
- **Target and journey:** `T1`, `T3`, `T4`; `bootstrap`, `provider-sign-in` and `removal`, all lasting.
- **Passes when:**
  - in H, the first non-owner attempt and the never-listed account are refused. The owner becomes the bound owner, with one `owner-bound` record;
  - the unlisted account ends at "not allowed", and D1 gains no `user`, `account` or `session` row for it;
  - after removal, every attempt in D is refused or inactive, writes nothing, and leaves no session row for A. The proposal stays pending;
  - the re-added person reaches the same Person id;
  - in E, every case gives its expected result;
  - in F, an apply held past `SD8` checks again and is refused when the removal landed in between. An apply within `SD8` with no removal changes state once;
  - after B signs out, the new-token request is refused and introspection of B's earlier token is inactive;
  - the owner who removed themselves can no longer administer.

  Wrong builds that fail it:
  - checks only before effects (E cases 1, 4, 5 and 7);
  - a decision that trusts the signature (Accept with the earlier token applies);
  - introspection that ignores the session row (B's earlier token stays active);
  - no freshness bound (F's held apply proceeds without a second check);
  - admin checked by owner id alone (the self-removed owner still administers);
  - "first user becomes owner" (H's first non-owner attempt gets in).
- **Reuses:** none.
- **Unverified:**
  - D1 replication behavior on the hosted database (E runs on `T3`, and `T1` keeps read replication off);
  - ordinary use continuing until the token expires, which the owner bounds through `SD3`;
  - the `SD8` value, a Lead default awaiting the owner.

### `U3` — public apps let anyone register

- **Obligations:** `R5` · proof obligation `V4` · seam: trace row R5.
- **Proven by:** on `T2`, a new GitHub account registers and adds a passkey (observations A and B, run against `T2`). Then observation C presents a `T2` token to `T4`.
- **Reference:** Spec C2.
- **Target and journey:** `T2` and `T4`; `provider-sign-in`, `passkey` and `proof-audience`, run against `T2`, lasting.
- **Passes when:**
  - registration on `T2` creates the Person;
  - `T4` refuses the `T2` token with `wrong-issuer`, even though the same email is on `T1`'s allowlist.

  Wrong builds that fail it:
  - a verifier that checks only signature shape;
  - shared signing keys or a shared database between deployments.
- **Reuses:** none.
- **Unverified:** everything here until `T2` is built. Whether that waits for the private deployment is `SD2`, still open: the Lead proposes private first, and the owner hasn't decided. Until the owner does, this row stays required and isn't counted as deferred.

### `U4` — each service gets proof that works only for itself

- **Obligations:** `R6`, `R7`; shares `R8`, `R9` and `R13` with the rows above · proof obligation `V5` · seams: trace rows R6, R7.
- **Proven by:** observations C and G, plus a D1 read of every registered client's grant types on `T1`.
- **Reference:** Spec C1 step 5; `R6`; `R7`.
- **Target and journey:** `T1` and `T4`; `proof-audience`, lasting.
- **Passes when:**
  - the console token is refused with `wrong-audience`, and Tool Portal's token verifies;
  - the `openid` token and the two-resource token, both with an array `aud`, are refused with `wrong-audience`;
  - in G, a token without `sid` is refused as `not-a-person`, and each other bad token gives its own reason;
  - no registered client lists `client_credentials`.

  Wrong builds that fail it:
  - a verifier that accepts any audience in an array;
  - one that checks `aud` but not `iss`;
  - one that accepts a service token as a person.
- **Reuses:** none.
- **Unverified:** the real console; the console's own verification of its proof (outside this design).

### `U5` — the owner's Cloudflare and database, no vendor

- **Obligations:** `R11` · proof obligation `V8` · seam: trace row R11.
- **Proven by:** a structural and release check:
  - the Worker's deployment configuration names the owner's account and one D1 binding of its own per deployment;
  - the deployed Worker's record on that account matches the delivered commit;
  - the package's dependencies include Better Auth and no hosted sign-in vendor.
- **Reference:** `R11`; the owner's `U5` words.
- **Target and journey:** `T1` (and `T2` when built); no journey.
- **Passes when:** each deployment's D1 id is distinct and owned by the owner's account, and no dependency or outbound call names a sign-in vendor. A build that points two deployments at one D1, or adds a hosted identity SDK, fails.
- **Reuses:** none.
- **Unverified:** CPU fit on Workers Free (`SD6`), which needs its own measurement.

### `U6` — machines and VMs never use people's sign-in

- **Obligations:** `R10`; with `R7` · proof obligation `V7` · seam: trace row R10.
- **Proven by:**
  - the existing VM lanes run with no sign-in service configured;
  - a structural check that no package on a machine path imports `@agent-collaboration/auth` or the person-proof verifier;
  - a D1 read on `T1` showing no client registered for a machine.
- **Reference:** Spec C3.
- **Target and journey:** agent-vm's VM lanes at the delivered commit; `T1`; no new journey.
- **Passes when:**
  - the VM lanes pass with no sign-in configuration present;
  - the import check finds no edge from agent-vm, gateway-runtime, the Gondolin adapter or the Tool VM packages to the sign-in package;
  - `T1` lists only people-facing clients.

  Wrong builds that fail it:
  - a controller or VM path that calls the sign-in Worker (the lanes fail without it);
  - a machine client registered on `T1`.
- **Reuses:** `pnpm test:e2e:vm`, which boots real Gondolin VMs and drives the controller and gateway runtime (for example `packages/agent-vm/src/integration-tests/live-gondolin-vm.vm.e2e.test.ts` and `gateway-runtime-vm-boundary.vm.e2e.test.ts`). It applies while it runs at the delivered commit with no sign-in settings.
- **Unverified:** VPN and Router access through Cloudflare, which this repository doesn't contain.

### `U7` — every change recorded, no secrets

- **Obligations:** `R12` · proof obligation `V9` · seam: trace row R12.
- **Proven by:** observation I, with the records from H, A and D.
- **Reference:** C1 setup and step 1; `R12`'s list of changes, and of what must never be recorded.
- **Target and journey:** `T1` and `T3`; `audit`, `bootstrap`, `provider-sign-in` and `removal`, lasting.
- **Passes when:**
  - each change kind `R12` lists has its record, naming the actor, the change and the time. For a change Better Auth writes itself, a before-change record and an outcome record are linked by request id;
  - each sign-in success and refusal has a record;
  - the search finds none of the captured values;
  - on `T3`:
    - a failed before-change write leaves no `passkey` or `account` row;
    - a failed outcome write leaves the before-change record;
    - a failed allowlist batch leaves neither the change nor its record.

  Wrong builds that fail it:
  - an audit row that stores the raw request body;
  - passkey or link changes with no record (I's search for their records finds none);
  - a change written outside its batch;
  - a log line with a token.
- **Reuses:** none.
- **Unverified:** retention and readers of the record (Tool Portal D6).

## What the plan must add

- **Journeys, all lasting:** `verify-auth` with `bootstrap`, `provider-sign-in`, `passkey`, `proof-audience`, `removal` and `audit`, as scripts in the project's scripts location.
- **Automated tests, no journey:**
  - E: held interleavings on `T3`, using a hold seam in the test composition only;
  - F: decision freshness at Tool Portal's `decide`;
  - G: verifier and gate rules;
  - the forced audit-write failures in I.
- **Owner access, before any of it runs:** the Cloudflare test account, the Google and GitHub test OAuth apps, and the four test identities.

## Rendering

- **At `ff5f3428`:** the 🦉 Advisor opened the four pages in a supported browser (Demistify 1.9.3). Desktop passed: the diagrams render as SVG, the Pages menu and sidebar work, and the embedded Markdown matches source. At phone width (430 px), wide tables were not readable enough to pass; that stays an open gap.
- **This revision:** the static checker passes. The browser check has not been repeated since these edits.
