# People sign-in: Verification Design

[Requirements](requirements.md) · [Specification](2026-10-20-people-sign-in.md) · [Program Design](program-design.md)

This is the plan for showing that people's sign-in does what the [Specification](2026-10-20-people-sign-in.md) requires. **Nothing here has been run or observed.** Every target property below describes a build that does not exist yet.

**Before any row can pass, the owner must grant:**
- a Cloudflare test account where the test deployments run (prerequisite P1 in the build plan);
- Google and GitHub test OAuth apps;
- three test identities: a Google account on the allowlist, a GitHub account with the same verified email, and a second Google account that is not listed.

No `verify-*` skill exists in this repository, so every journey below is `needed`. The plan builds them under a new `verify-auth` skill.

## What will prove each need

| Need | In plain words | Proven by | Stays unverified |
| --- | --- | --- | --- |
| `U1` | Sign in with Google, GitHub or a passkey, and nothing else | On the test deployment, sign in with each provider and with a passkey and land on the same person each time. Every other sign-in route answers "not found". A second provider with the same email is refused until it is linked on purpose. | real people's devices and browsers beyond the one used |
| `U2` | Only people the owner approved get into private apps | An unlisted account is turned away, and nothing is stored for it. After the owner removes someone, their passkey, their open sessions and their pending Accept all fail, including a sign-in caught halfway when the removal lands. | how long the deployed database takes to make a removal visible everywhere (only the local runtime holds steps in order) |
| `U3` | Public apps let anyone register | Register on the public deployment, then show its proof being refused by the private deployment's Tool Portal. | waits for the public deployment (`SD2`: private first) |
| `U4` | Each service gets proof that works only for itself | The console's proof is refused by Tool Portal and Tool Portal's is accepted. A proof with two audiences, or one that doesn't stand for a person, is refused. | the real console (a scripted stand-in calls instead) |
| `U5` | Runs on the owner's Cloudflare with its own database, no vendor | Read the deployment settings and the deployed Worker's own record: the owner's account, a database of its own, and no sign-in vendor in the code. | Workers Free CPU fit (`SD6`), measured separately |
| `U6` | Machines and VMs never use people's sign-in | The VM test lanes run with no sign-in service present. No machine is registered as a sign-in client, and no machine package depends on the sign-in package. | VPN and Router traffic through Cloudflare, which live outside this repository |
| `U7` | Every change to who may sign in is recorded, with no secrets | Read the audit table after the changes: one record per change, with who, what and when. Search it and the Worker's logs for the real codes, tokens and cookies seen during the run; none appear. | how long records are kept (Tool Portal D6) |

## Targets

| Id | What | Used for |
| --- | --- | --- |
| `T1` | The private test deployment: the `@agent-collaboration/auth` Worker at the delivered commit, deployed to the owner's Cloudflare test account with its own D1, `mode: "private"`, the test OAuth apps, and the owner as administrator (`SD1` default) | every journey |
| `T2` | The public test deployment: the same commit, `mode: "public"`, its own Worker and D1 | `U3`, when `SD2` builds it |
| `T3` | The same Worker build on a local Workers runtime with a local D1 | held interleavings only. It is not hosted proof: it keeps Better Auth, the hooks and the database statements real, but not D1's replication |
| `T4` | Tool Portal at the slice that delivers `decide`, using the production person-proof verifier configured to trust `T1` | decisions, audiences, freshness |
| client | A scripted stand-in for the console: a registered client that runs authorization code with S256 PKCE | asking for proofs. It stands in until the console exists, and it is never counted as console proof |

## Shared observations

Each observation is described once; the rows below say which obligations it decides.

**A. Provider sign-in** (`verify-auth` `provider-sign-in`, needed, lasting). The journey runs on `T1` in a real browser.
- **Steps:**
  1. Sign in with the listed Google account.
  2. Try the unlisted Google account.
  3. Try the GitHub account that has the same verified email.
  4. Sign in with Google again and link GitHub from the account page.
  5. Sign out and sign in with GitHub.
- **Read:** the screen's outcome for each step, and the D1 `user`, `account`, `session`, `allowed_email` and `sign_in_audit` rows, through read-only queries.
- **Human step:** Google's and GitHub's own login screens may need a person. The script pauses there and records who completed the step.

**B. Passkey** (`verify-auth` `passkey`, needed, lasting). A scripted browser with a virtual WebAuthn authenticator runs on `T1`.
- **Steps:**
  1. Person A, signed in, registers a passkey, signs out and signs back in with it.
  2. Try to register a passkey with no session (`SD7` default).
  3. Try to sign in with a passkey that was deleted.
- **Read:** the session's user id in D1, compared with Person A's id from journey A.

**C. Proofs across services** (`verify-auth` `proof-audience`, needed, lasting). The stand-in client obtains three tokens from Person A's session on `T1`:
- one for the console's resource;
- one for Tool Portal's;
- one for Tool Portal's that also asks for `openid`.

Each token goes to `T4`'s control API `explain` and to the verifier. **Read:** the verifier's result kind and reason, and Tool Portal's response. When `T2` exists, a `T2` token goes to `T4` too.

**D. Removal and sign-out** (`verify-auth` `removal`, needed, lasting). On `T1` and `T4`.
- **Setup:** Person A holds a Google browser session, a second browser's passkey session, a Tool Portal token taken before removal, and a pending proposal in `T4`.
- **Act:** the owner removes A through the admin surface.
- **Attempt:** a passkey sign-in; a new token from the surviving browser session; Accept with the earlier token; introspection of that token.
- **Read:** each refusal; the E8 `removedAt`; the session rows; the audit record; the proposal's state in `T4`.
- **Sign-out branch:** Person B signs out. Then try a new token from that session and introspect B's earlier token.

**E. Held interleavings** (automated integration on `T3`, no journey). The test's composition wraps the session-creation hook with a latch, so a step can be held.
1. A passkey sign-in passes the hook and is held before its session insert. The removal batch commits; then the sign-in resumes. With the late session, request a code, exchange a token and introspect. **Read:** each answer, and D1's `session`, OAuth code and token rows.
2. The same with a Google callback, its provider answer replayed from a recorded test profile.

**F. Decision freshness** (Tool Portal integration at the `decide` slice, no journey). Run on `T4`'s `decide` with the production verifier calling `T3`, under a controlled clock:
1. the live check passes, then the commit is held past `SD8`;
2. the same, with the removal landing in between;
3. a check within `SD8` with no removal.

**Read:** whether the decision applied, and whether a second check was made.

**G. Focused rules** (unit, no journey):
- *The verifier's token rules*, with real JOSE signing over test keys. Each of these must give its own reason: wrong `typ`, bad signature, wrong `iss`, an `aud` that is another service, an `aud` array containing this service, expired, `sid` missing. A token that is correct in every way verifies.
- *The allowlist gate's email rule*, over the profile shapes Better Auth's Google and GitHub mappers produce: verified and listed matches, with case ignored; unverified never matches; removed never matches.

## Rows

### `U1` — sign in with Google, GitHub or a passkey only

- **Obligations:** `R1`, `R2`, `R8` · proof obligations `V1`, `V6` · seams: Program Design trace rows R1, R2, R8.
- **Proven by:** observations A and B. Also an API transcript on `T1` that requests every Better Auth sign-in and sign-up route not configured: `/sign-in/email`, `/sign-up/email`, `/sign-in/magic-link`, `/sign-in/oauth2`, the OAuth-proxy callback and `/sign-in/anonymous`.
- **Reference:** Spec C1 steps 2–4; `R1`'s list of three methods; `R8`'s "link it from your account" outcome.
- **Target and journey:** `T1`; `provider-sign-in` and `passkey`, both lasting.
- **Passes when:**
  - each provider sign-in and the passkey sign-in end with a session whose user id equals Person A's;
  - every unconfigured route answers 404;
  - the GitHub attempt before linking shows the link message, and D1 gains no `user` or `account` row;
  - after explicit linking, a GitHub sign-in reaches Person A;
  - passkey registration with no session is refused.

  Wrong builds that fail it:
  - email-and-password left enabled (a route answers);
  - implicit linking on (a GitHub `account` row appears before linking);
  - a passkey sign-in that creates a second user.
- **Reuses:** none.
- **Unverified:** browsers and authenticators other than the one used; real hardware passkeys (a virtual authenticator stands in).

### `U2` — only approved people get into private apps

- **Obligations:** `R3`, `R4`, `R9`, `R13` · proof obligations `V2`, `V3` · seams: trace rows R3, R4, R9, R13.
- **Proven by:** observation A for an unlisted account; D for removal and sign-out; E for a removal landing mid-sign-in; F for decision freshness; G for the email rule.
- **Reference:** Spec C1 steps 2 and 6; `R4`'s cutoff ("takes effect when it is recorded"); `R9`'s `SD8` bound; the Specification's failure table.
- **Target and journey:** `T1`, `T3`, `T4`; `provider-sign-in` and `removal`, both lasting.
- **Passes when:**
  - the unlisted account ends at "not allowed", and D1 gains no `user`, `account` or `session` row for it;
  - after removal, the passkey sign-in, the new token request, the Accept and the introspection are all refused or inactive; the proposal stays pending; no session row remains for A;
  - in E, a code the late session obtains cannot be exchanged for a token, and introspection of any token tied to it is inactive;
  - in F, a commit held past `SD8` checks again, and is refused when the removal landed in between, while a commit within `SD8` with no removal applies once;
  - after B signs out, the token request is refused and introspection of B's earlier token is inactive.

  Wrong builds that fail it:
  - a gate only at session creation (E's late session gets a signed token);
  - a decision that trusts the signature (Accept with the earlier token applies);
  - introspection that ignores the session row (B's earlier token stays active);
  - a missing freshness bound (F's held commit applies without a second check).
- **Reuses:** none.
- **Unverified:**
  - D1 replication delay on the hosted database (E runs on `T3`);
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
- **Unverified:** everything here until `SD2` builds the public deployment. That deferral is the owner's existing decision.

### `U4` — each service gets proof that works only for itself

- **Obligations:** `R6`, `R7`; shares `R8`, `R9` and `R13` with the rows above · proof obligation `V5` · seams: trace rows R6, R7.
- **Proven by:** observations C and G, plus a D1 read of every registered client's grant types on `T1`.
- **Reference:** Spec C1 step 5; `R6`; `R7`.
- **Target and journey:** `T1` and `T4`; `proof-audience`, lasting.
- **Passes when:**
  - the console token is refused with `wrong-audience` and Tool Portal's token verifies;
  - the `openid` token, whose `aud` is an array, is refused with `wrong-audience`;
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
- **Proven by:** after journeys A and D, export the `sign_in_audit` table and tail the Worker's logs for the run. Then search both for every authorization code, access token, session cookie, passkey credential id and public key captured during the run. Also hold a D1 batch failure on `T3` during an allowlist change.
- **Reference:** C1 step 1; `R12`'s list of what must and must not be recorded.
- **Target and journey:** `T1` and `T3`; `provider-sign-in` and `removal`, lasting.
- **Passes when:**
  - each allowlist add and remove, and each relying-service change, has exactly one record naming the actor, the change and the time;
  - each sign-in success and refusal has a record;
  - the search finds none of the captured values;
  - a failed batch leaves neither the change nor its record.

  Wrong builds that fail it:
  - an audit row that stores the raw request body;
  - a change written outside the batch (the change lands without its record);
  - a log line with a token.
- **Reuses:** none.
- **Unverified:** retention and readers of the record (Tool Portal D6).

## What the plan must add

- **Journeys, all lasting:** `verify-auth` with `provider-sign-in`, `passkey`, `proof-audience` and `removal`, as scripts in the project's scripts location.
- **Automated tests, no journey:** E (held interleavings on `T3`), F (decision freshness at Tool Portal's `decide`) and G (verifier and gate rules).
- **Owner access, before any of it runs:** the Cloudflare test account, the Google and GitHub test OAuth apps, and the three test identities.
