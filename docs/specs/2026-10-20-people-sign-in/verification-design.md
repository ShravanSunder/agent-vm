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
| `U8` | Agents sign in as themselves, one workspace at a time | Add a test agent to two workspaces of one organization. Read back that it can only use its own sign-in, that the other grant is refused, and that it gets no token for another organization's workspace. Call each workspace with that workspace's own real token; the other workspace and a person check refuse it. Remove it from one workspace: on the same running instances its old call there and a new token for that workspace both fail, while a new token for the other workspace still works. Retire it, and every token request and call fails. Both operations are also tried failing halfway and with a request caught in flight. | the real console (the person verifier stands in); each host's credential storage; creating and closing workspaces (not in this work) |

## Targets

| Id | What | Used for |
| --- | --- | --- |
| `T1` | The private test deployment: the `@agent-collaboration/auth` Worker at the delivered commit, deployed to the owner's Cloudflare test account with its own D1 (read replication off), `mode: "private"`, the test OAuth apps, and `ownerEmail` set to the owner test account | every journey |
| `T2` | The public test deployment: the same commit, `mode: "public"`, its own Worker and D1 | `U3`, when built |
| `T3` | The same Worker build on a local Workers runtime with a local D1 | held interleavings and forced audit-write failures. Not hosted proof: it keeps Better Auth, the hooks, the request handler and the database statements real, but not D1's replication |
| `T4` | Tool Portal at the slice that delivers `decide`, using the production person-proof verifier configured to trust `T1` | decisions, audiences, freshness |
| `T5` | Tool Portal's Worker (`tool-host-cloudflare`) serving organization O1's workspaces W1 and W2 and organization O2's workspace W3, each with its own Durable Object, and its agent-management handler, using the production agent verifier configured to trust `T1` (or `T3`), on local workerd and on the owner's test account, bound to the sign-in Worker's agent-client route | agent calls, removal, held interleavings |
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
- **Two-entry branch:** Person C has two allowlisted addresses, both bound to them: C signed in with Google on one and linked GitHub on the other. The owner removes one address. C's passkey sign-in, a new token and an Accept are all refused. Re-adding that address restores C.

**E. Held interleavings** (automated integration on `T3`, no journey). The test's composition can hold a request at a named step while the removal batch, or a sign-out, commits on another request. Each case is a separate run:
1. A passkey sign-in held after its session insert, before the final check. **Expect:** refused; no session row for A.
2. The same sign-in held after the final check, before the response leaves. **Expect:** the session reaches the browser, but the removal has deleted its row, so the next request with it fails.
3. A Google sign-in held before its session insert. **Expect:** refused at the final check.
4. A token request held after signing, before the final check. **Expect:** `invalid_grant`, and no token reaches the client.
5. The same, with a sign-out committing instead of a removal. **Expect:** `invalid_grant`.
6. A token request held after the final check. **Expect:** the token reaches the client; introspection of it is inactive; its `exp` is within `SD3`.
7. Introspection held after Better Auth's own `sid` read, before the final check. **Expect:** `{ active: false }`.
8. Introspection held after the final check. **Expect:** `active` with a `checkedAt` before the removal.
9. A first Google sign-in held at two points while the owner removes that entry: (a) after the gate's read, before either of Better Auth's writes; (b) after both writes, before the bind. **Expect:** refused in both. Read back the `user`, `account`, `allowed_email` binding, `session` and `sign_in_audit` rows: no `user` or `account` row for that login remains, and there is no session.
10. The same hold on the owner's first sign-in on an empty deployment, while a second, never-listed account tries. **Expect:** exactly one `deployment_owner` row naming the owner, and one `owner-bound` record.
11. Case 9(b) with the cleanup batch made to fail. **Expect:** the `user` and `account` rows remain, unbound. The failure is recorded, and a later sign-in with that login is refused while its entry stays removed.
12. Case 9(c): the first sign-in's check binds the entry, then the removal commits before the final check. **Expect:** refused. The `user`, `account` and binding remain as a removed Person, with no session. Re-adding the address reactivates that same Person id.
13. Request A is refused at its final check and held before its cleanup batch. The owner re-adds the address, and request B signs in with the same provider account and is admitted. Then A's cleanup runs. **Expect:** B's Person id, `account` row, binding and session all survive; A's cleanup deletes nothing; A ends "not allowed".
14. The reverse order: A's cleanup commits first, then B's bind runs against the deleted user. **Expect:** B's bind binds nothing, B is refused with no binding left pointing at a missing user, and B's retry creates a fresh Person.

**Read:** each response, and D1's `session`, OAuth code and token rows. A build whose only checks run before the effect fails cases 1, 4, 5 and 7. A build that binds in a user-creation hook, or keeps a refused first sign-in's rows, fails case 9's readback. A cleanup that deletes by request alone fails case 13.

**F. Decision freshness** (Tool Portal integration at the `decide` slice, no journey). Run on `T4`'s `decide` with the production verifier calling `T3`, under a controlled clock:
1. the live check passes, then the apply is held past `SD8`;
2. the same, with a removal landing in between;
3. an apply within `SD8` with no removal.

**Read:** whether the apply changed state, and whether a second live check was made, measured at the apply.

**G. Focused rules** (unit, no journey):
- *The verifier's token rules*, with real JOSE signing over test keys. Each of these must give its own reason: wrong `typ`, bad signature, wrong `iss`, an `aud` that is another service, an `aud` array containing this service (from `openid` and from two resources), expired, and `sid` missing. A token that is correct in every way verifies.
- *Each verifier's identity-class check, isolated.* Signed test fixtures that pass every earlier check of the verifier under test (its own `typ`, issuer and audience, unexpired), differing only in the identity claims: one without `sid` at the person verifier gives `not-a-person`, and one with `sid` at the agent verifier for a workspace audience gives `not-an-agent`. These are test fixtures, not tokens the issuer can produce.
- *The agent verifier's token rules*, the same way: wrong `typ`, bad signature, wrong `iss`, an `aud` that is another workspace's address (including one in the same organization), expired, a `sid` present or `organization_id` or `workspace_id` missing (`not-an-agent`), a `workspace_id` naming a different workspace than the address (`wrong-workspace`), and a `scope` without `tool-portal:agent` (`wrong-scope`) each give their own reason. A correct agent token verifies and projects `AgentProof` with its `workspaceId`.
- *The allowlist gate:*
  - **email rule**, over the profile shapes Better Auth's Google and GitHub mappers produce: verified and listed matches, with case ignored; unverified never matches; removed never matches;
  - **derived active state:**
    - every bound entry allowed: active;
    - any bound entry removed: inactive, including when another bound entry is still allowed;
    - re-added with the rest allowed: active again;
    - no bound entry: bind the matching allowed entry, or inactive.

**I. Audit coverage** (`verify-auth` `audit`, needed, lasting; plus forced failures on `T3`).
- **On `T1`:**
  - make each change kind `R12` lists: add and remove an allowlist entry; re-add; register, update and retire a client and a relying service; link an agent client to a workspace and unlink it; add and remove a passkey; link and unlink a login. The owner binding comes from H.
  - Export `sign_in_audit` and tail the Worker's logs for the run. Search both for every code, access token, session cookie, passkey credential id and public key captured during A–D and I.
- **On `T3`:**
  - make the before-change audit write fail during a passkey registration, a link and an agent-client registration; no `passkey`, `account` or E9 row may appear;
  - make the agent client's resource-link write, then its outcome write, fail during registration; no credential is returned, no membership is written, the registration reads as incomplete, and the owner's retry completes it;
  - make the outcome write fail after a change; the before-change record must still be there;
  - make an allowlist batch fail; neither the change nor its record may land.

**J. Agent sign-in, workspaces and removal** (`verify-auth` `agent`, needed, lasting, on `T1` with `T5`; plus held cases on `T3` with `T5` local). Reads the Program Design's [Adding, removing and retiring an agent](./program-design.md#adding-removing-and-retiring-an-agent-r17-r18). Setup: organization O1 with workspaces W1 and W2, and organization O2 with workspace W3, all served by `T5`.
- **Register and link:** through `T5`'s agent-management handler, add a test agent to W1, then to W2. The second add returns no credential. Read straight from D1:
  - the E9 row: `grant_types` exactly `["client_credentials"]`, `client_credentials_scopes` exactly `["tool-portal:agent"]`, metadata `{ kind: "agent", organizationId: O1 }`, and absent from the deployed `cachedTrustedClients`;
  - exactly two `oauthClientResource` links, to W1's and W2's resources;
  - each workspace resource: identifier its MCP address, metadata `{ kind: "workspace", organizationId: O1, workspaceId }`, `allowedScopes` `["tool-portal:agent"]`, null `customClaims`;
  - the before-change and outcome records for the client, each resource and each link.
- **Forbidden grant:** start an authorization-code request with the agent's client id, as the stand-in client would. **Expect:** refused, with no code issued.
- **Use:** get a token for W1; its `aud` is W1's address, `organization_id` O1 and `workspace_id` W1. Call one tool on W1. **Expect:** it runs once, against W1's tools. Then:
  - present the W1 token at W2's address: `wrong-audience`;
  - request a token for W3 (O2's workspace), and for an O1 workspace the agent was never added to: `invalid_target` each;
  - present the W1 token to the person verifier, which is what the console will run: `wrong-audience`, because the audience check comes first (G isolates `not-a-person`);
  - present Person A's Tool Portal token to `T5`'s agent check at W1: `wrong-audience` (G isolates `not-an-agent`);
  - ask for a W1 token from Person A's session with the ordinary stand-in client, which isn't linked to W1: `invalid_target`;
  - with a person code client that the test composition links to W1 and allows `tool-portal:agent`, so the library's link and scope checks pass, ask for a W1 token from Person A's session: refused `invalid_target` by the issuance checks, with no token in the response.
- **Refused management** (through `T5`'s handler and the real service binding): an add with no person token, with the agent's own E10, with a revoked session, and by a Person who isn't the bound owner; and an add of O1's agent to W3, O2's workspace. **Expect:** each refused, and D1 shows no new resource, client or link, and no membership is written.
- **Remove from W1, warm:** keep the W1 token (`tok-w1-old`). Remove the agent from W1 through the handler. Then, on the **same** `T5` instance that served the earlier call and on the sign-in Worker that issued the token:
  - call W1 with `tok-w1-old`: refused, not a member;
  - request a new W1 token: `invalid_target`;
  - once the removal reads complete, request a **new** W2 token and call W2 with it: it runs once;
  - read the handler's status ("removal complete"), W1's object (agent removed), W2's object (still a member), D1 (W1 link gone, W2 link present, E9 enabled) and the `client-link-changed` records naming the acting Person.
- **Retire, warm:** keep the W2 token (`tok-w2-old`). Retire the agent:
  - call W2 with `tok-w2-old`: refused;
  - request a new W2 token: `invalid_client`;
  - read the status ("retirement complete"), the disabled E9 row and its records.
- **Between the writes** (on `T3` with `T5` local; the test composition makes the agent-client route fail once): remove one agent from W1, and separately retire a second agent. **Expect:** status "pending" each time; a call on the affected workspace with any token is refused; a new token request for it still succeeds, which is the named gap. Retry. **Expect:** status "complete"; then the unlinked workspace's token request gets `invalid_target`, and the retired agent's gets `invalid_client`.
- **Held races and conflicting claims** (on `T3`, with the hold seam from E):
  1. a W1 token request held **after Better Auth has signed the token** (past the credential check and `customAccessTokenClaims`), immediately before the handler's final D1 check; the W1 unlink commits while it is held, then it is released. **Expect:** `invalid_target`, and no token in the response.
  2. the same hold, with the client's disable committing instead. **Expect:** `invalid_client`, no token.
  3. a W1 token issued before removal, used after the membership is removed and before the unlink. **Expect:** refused, not a member.
  4. a resource custom claim on `T3` that sets `organization_id` to O2 on W1's resource, then a W1 token request by O1's agent. **Expect:** `invalid_client`; no token naming O2 is released.
  5. a resource custom claim on `T3` that sets `workspace_id` to W2 on W1's resource, then a W1 token request. **Expect:** `invalid_client`.
  6. a link from O1's agent to W3's resource written straight into D1 by the test composition, then a W3 token request. **Expect:** refused, with no token released (the early check catches this one).
  7. a W1 token request by O1's agent, held after Better Auth has signed it with `organization_id` O1 and `workspace_id` W1, which match the client and W1's resource at signing. While it's held, the test composition changes W1's resource metadata to name O2. Released. **Expect:** `invalid_client`, no token. Only the final check's comparison of the resource's organization with the client's catches this.

**Read:** each response; the E9, link, resource and audit rows; each workspace object's agent row; the handler's status. Wrong builds that fail it:
- a client registered with authorization code as well fails the readback and the forbidden-grant attempt;
- a Worker that caches membership fails the warm W1 call;
- a client listed in the trusted cache fails the warm token request;
- an unlink that removes every link, or a removal that disables the client instead of unlinking, fails the new W2 token;
- a build with only the early checks fails held cases 1 and 2;
- a final check that skips the signed-claim comparisons fails held cases 4 and 5, and one that skips the resource-organization comparison fails held case 7;
- a route that calls the library without the installed session fails every add (the library refuses it), and one that skips the person, owner or organization check fails a refused-management case;
- a person guard that relies on `allowedScopes` alone fails the linked person code client case;
- a handler that reports "complete" after one write fails the between-writes case.

## Rows

### `U1` — sign in with Google, GitHub or a passkey only

- **Obligations:** `R1`, `R2`, `R8`, and the Specification's privacy obligation · proof obligations `V1`, `V6` · seams: Program Design trace rows R1, R2, R8.
- **Proven by:** observations A and B, and the account-row read in A.
- **Reference:** Spec C1 steps 2–4; `R1`'s list of three methods; `R8`'s "link it from your account" outcome; the privacy list in the Specification's cross-cutting obligations.
- **Target and journey:** `T1`; `provider-sign-in` and `passkey`, both lasting.
- **Passes when:**
  - each provider sign-in and the passkey sign-in end with a session whose user id equals Person A's;
  - each well-formed attempt through another method creates no `user`, `account` or `session` row and sets no session cookie, whatever status it answers;
  - the configuration enables only the Google and GitHub providers, the passkey and OAuth-provider plugins, and the JWT plugin the OAuth provider needs, with that plugin's own token endpoint disabled;
  - before linking, the GitHub attempt shows the link message and D1 gains no `user` or `account` row;
  - after linking by redirect, a GitHub sign-in reaches Person A;
  - the ID-token linking form is refused and adds no `account` row;
  - linking a login whose verified email differs succeeds when that email is allowlisted, and is refused with no `account` row when it isn't;
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
  - in the two-entry branch, removing one of C's two addresses stops C, and re-adding it restores C;
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
  - no person-facing client lists `client_credentials`; only agent clients do, with no other grant.

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
  - `T1` lists only people-facing clients and agent clients, and no machine or VM client.

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
    - a failed before-change write leaves no `passkey`, `account` or E9 row;
    - a failed resource-link or outcome write during agent-client registration returns no credential and writes no membership, until a retry completes it;
    - a failed outcome write leaves the before-change record;
    - a failed allowlist batch leaves neither the change nor its record.

  Wrong builds that fail it:
  - an audit row that stores the raw request body;
  - passkey or link changes with no record (I's search for their records finds none);
  - a change written outside its batch;
  - a log line with a token.
- **Reuses:** none.
- **Unverified:** retention and readers of the record (Tool Portal D6).

### `U8` — agents sign in as themselves, one workspace at a time

- **Obligations:** `R15`, `R16`, `R17`, `R18` · proof obligations `V11`, `V12` · seam: trace row R15–R18.
- **Proven by:** observations J and G: add a test agent to two workspaces of one organization, read back how it's registered and linked, try the grant it must not have and a workspace of another organization, call each workspace with its own real token, remove it from one workspace and show the other still works with a new token, retire it, and repeat both operations failing halfway and with requests held in flight.
- **Reference:** Spec C4; `R15`–`R18`; Program Design [Adding, removing and retiring an agent](./program-design.md#adding-removing-and-retiring-an-agent-r17-r18).
- **Target and journey:** `T1` with `T5`, and `T3` with `T5` local for the held and between-writes cases. Journey `verify-auth` `agent`, needed, lasting: it must drive `T5`'s agent-management handler and the sign-in token endpoint, and read D1, each workspace's object and the handler's status.
- **Passes when:**
  - the E9 row has only `client_credentials`, only `tool-portal:agent`, agent metadata, and is not trusted-cached; an authorization-code request with its id is refused;
  - the agent's links are exactly the workspaces it was added to, each workspace resource carries its organization and workspace, and no token is issued for another organization's workspace or for one it wasn't added to;
  - `T5` accepts the W1 token at W1 only and W2 refuses it; the person verifier and the agent check each refuse the other kind's real token (`wrong-audience`), and G's fixtures give `not-a-person` and `not-an-agent`;
  - no person token is released for a workspace, including through a linked person code client;
  - every refused management request leaves no resource, client, link or membership change;
  - after removal from W1, on the same warm instances, the old W1 token's call is refused, a new W1 token request gets `invalid_target`, and a **new** W2 token works once with E9 still enabled;
  - after retirement, the old W2 token's call is refused and a new token request gets `invalid_client`;
  - between the writes, calls are refused and status is pending; after retry, status is complete and the token requests are refused;
  - every held and conflicting-claim case ends refused, with no token released.

  Wrong builds that fail it:
  - a client registered with authorization code as well as client credentials (readback, forbidden grant);
  - a verifier that accepts a token without checking `sid` or `workspace_id` (G);
  - a Worker that caches membership (warm call);
  - an agent client in the trusted-client cache (warm token request);
  - an unlink-all, or a removal that disables the client (the new W2 token);
  - a handler that reports complete after one write (between writes);
  - a final check deleted, leaving only the early checks (held cases 1 and 2);
  - a final check that skips the signed-claim comparisons (held cases 4 and 5) or the resource-organization comparison (held case 7);
  - a route without the installed session, the person and owner check, or the organization check (refused management, and every add);
  - a person guard that relies on `allowedScopes` alone (the linked person code client);
  - an agent client without its first resource link (readback, and its own token request fails `invalid_target`).
- **Reuses:** none yet.
- **Unverified:** the real console, which doesn't exist yet: the person verifier stands in for it, and the console's own check is outside this design. Also the agent's host storing its credential, which each host proves with its own wiring; D1's hosted replication timing (only `T3` holds steps in order); creating and closing workspaces, which aren't in this work; and where an organization's owner and allowlist are kept, which waits on the owner.

## What the plan must add

- **Journeys, all lasting:** `verify-auth` with `bootstrap`, `provider-sign-in`, `passkey`, `proof-audience`, `removal`, `audit` and `agent`, as scripts in the project's scripts location.
- **Automated tests, no journey:**
  - E: held interleavings on `T3`, using a hold seam in the test composition only;
  - J's held races and between-writes case, on `T3` with `T5` local, using the same hold seam and a one-time failure of the agent-client route in the test composition only;
  - F: decision freshness at Tool Portal's `decide`;
  - G: verifier and gate rules;
  - the forced audit-write failures in I.
- **Owner access, before any of it runs:** the Cloudflare test account, the Google and GitHub test OAuth apps, and the four test identities.

## Rendering

- **At `ff5f3428`:** the 🦉 Advisor opened the four pages in a supported browser (Demistify 1.9.3). Desktop passed: the diagrams render as SVG, the Pages menu and sidebar work, and the embedded Markdown matches source. At phone width (430 px), wide tables were not readable enough to pass; that stays an open gap.
- **This revision:** the static checker passes. The browser check has not been repeated since these edits.
