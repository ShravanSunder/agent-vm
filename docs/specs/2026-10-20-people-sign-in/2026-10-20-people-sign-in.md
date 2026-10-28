# People sign-in: Specification

[Requirements](requirements.md) · [Fleet decisions](../2026-10-18-fleet-framework/2026-10-18-fleet-framework.md) · [Switchboard Specification](../2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md)

This is what must be observably true of people's sign-in, judged from outside the service. The service is one opaque system here. How it is built belongs to Program Design.

## The system and who touches it

```mermaid
flowchart TB
  people["Organization owners and members, public users"]
  operator["Deployment operator"]
  signin["Sign-in service (one deployment: private or public)"]
  google["Google"]
  github["GitHub"]
  device["Person's device (passkey)"]
  console["Console"]
  tp["Switchboard control API"]
  machines["Machines, VMs, VPN, personal fleet"]
  cf["Cloudflare access"]
  people -->|sign in to one organization, register passkey, sign out| signin
  operator -->|registers organizations and names each one's owner| signin
  signin -->|verify identity| google
  signin -->|verify identity| github
  signin -->|passkey challenge| device
  signin -->|proof for the console only| console
  signin -->|proof for Tool Portal only| tp
  machines -->|not through sign-in| cf
```

The sign-in service never serves machines or VMs (`U6`). Agents sign in only as agents, never as people (`U8`). In a private deployment a person signs in to one organization at a time, and what that organization's owner allows decides whether they get in (`U9`). The service does not decide what a person may do inside a relying service; each service checks that itself.

## Problems and outcomes

| Problem | Outcome |
| --- | --- |
| `P1` People are identified only by Cloudflare Access, configured per app, with no passkeys (`U1`, `U5`). | `O1` A person signs in to our private apps with Google, GitHub or a passkey through our own service. |
| `P2` A private app has no list of who may sign in to an organization that its owner controls, and no record of changes to it (`U2`, `U7`). | `O2` Only people an organization's owner approved get into that organization. Every change to the list is recorded. Removal stops privileged actions in that organization at once. |
| `P3` Our services have no proof of a person that each can verify for itself; Switchboard's Accept needs one (`U4`). | `O3` Each relying service receives proof valid only for itself. |
| `P4` There is no way to run a public app with self-registration (`U3`). | `O4` A public deployment lets anyone register, separated from private ones. |
| `P5` Organizations that share one deployment aren't kept apart today: one owner administers all of them, and one list admits a person to all of them (`U9`). | `O5` Each organization admits, removes and administers its own people and agents, and nothing done in one changes or opens another. |

## Entities

| Entity | Identity rule | Relationships | Invariants | Observable states |
| --- | --- | --- | --- | --- |
| `E1` Deployment | One sign-in service instance, identified by its issuer address. A private and a public deployment are different deployments, even when built from the same code. | has many E2, E5, E7; a private one registers 1..n E12 | People, sessions and proofs of one deployment are never accepted by another | private or public |
| `E12` Organization | One organization a private deployment registers, identified by its UUID: the same identifier and meaning as Switchboard's E1 Organization, which contains workspaces (F-82). Its owner is named by the deployment's operator as a provider-verified email. | belongs to one E1; has exactly one owner, the E2 that first signs in to it with that email; has 0..n E8, 0..n E5, 0..n E9 and the workspace E6s that belong to it | Only its owner may list or change its E8s, read its records or manage its agents (`SD1`, `SD9`). Admission, removal and ownership in one organization never change another's. Until its owner first signs in, it admits no one else | awaiting its owner → owned. An organization the deployment no longer registers admits no one |
| `E2` Person | One account in one deployment, identified by a stable id that deployment assigns. The same human signing in with Google and with GitHub is one Person only after the signed-in Person explicitly links the second login; matching email addresses alone never merge them. The same Person may be admitted to several organizations; each admits them separately. | belongs to one E1; has 1..n E3, 0..n E4, 0..n E5; admitted to 0..n E12, each through that organization's own E8s | Keeps the same id across passkey, Google and GitHub sign-ins once linked, and across organizations. Being admitted to one organization says nothing about another | per organization: active there, or not (never admitted, or removed) |
| `E3` Linked login | One Google or GitHub account, identified by provider plus that provider's account id, attached to one Person. | belongs to one E2 | A provider account is linked to at most one Person per deployment | linked, unlinked |
| `E4` Passkey | One WebAuthn credential a signed-in Person registered, identified by its credential id. | belongs to one E2 | Usable only to sign in as its own Person; holds no biometric data or private key | active, removed |
| `E5` Session | One signed-in period of one Person in one organization of one deployment. Signing in to another organization starts another session. | belongs to one E2 and, in a private deployment, to one E12 | Carries authority only in its own organization. Ends at sign-out, expiry, or the Person's removal from its organization | active, signed out, expired, revoked |
| `E6` Relying service | One of our services that receives proof of a person or an agent, identified by its audience identifier: the console; Switchboard's control API; and each Switchboard workspace, identified by its own MCP address (F-73, F-75). Two workspaces are two relying services, even in the same organization. | registered in one E1; receives many E7 or E10. A workspace relying service belongs to exactly one E12 (F-82) | Proof for one relying service is never valid for another | registered, retired |
| `E7` Person proof | Evidence issued to one relying service that one Person is signed in to one organization, valid for that service only and for a bounded time. | names one E2, one E6 and, in a private deployment, the E12 of the session it was issued during; issued during one E5 | Represents a person acting in that organization only, never a service or machine | valid, expired, withdrawn |
| `E8` Allowlist entry | One provider-verified email address that one organization's owner approved for that organization, compared case-insensitively. It is identified by the organization plus the address, so the same address on two organizations' lists is two entries. An unverified address never matches. | belongs to one E12; admits at most one E2, the Person it first admitted | Changes are recorded (`R12`). A Person is active in an organization exactly while at least one of that organization's E8s admits them and every E8 of that organization bound to them is allowed. One organization's entries never admit anyone to another | allowed, removed |
| `E9` Agent client | One agent registered to sign in as itself in one deployment, identified by its client id; registered for one organization. | belongs to one E1 and one E12; has 0..n E11, one per workspace it may get proofs for; receives many E10 | Signs in only with its own registered credential; never a Person; gets an E10 only for a workspace it has a linked E11 for | active, removed |
| `E10` Agent proof | Evidence issued to one workspace that one agent client signed in, valid at that workspace only and for a bounded time. | names one E9, one workspace E6 and that workspace's E12 | Represents an agent, never a person; never accepted as an E7; refused at every other workspace, including one in the same organization | valid, expired |
| `E11` Workspace link | One agent client allowed to get proofs for one workspace, identified by the pair of that E9 and that workspace E6. | belongs to one E9 and one workspace E6, both of the same E12 | An E9 is never linked to a workspace of another organization. Unlinking one workspace changes none of the agent's other links and leaves its E9 active | linked, unlinked |

The sign-in service keeps who may sign in to an organization (E12, E8). Switchboard keeps which agents are members of each of its workspaces. A public deployment registers no organizations until `SD2` is settled.

```mermaid
flowchart TB
  D["E1 Deployment: private or public"]
  O["E12 Organization: awaiting its owner, owned"]
  A["E8 Allowlist entry: allowed, removed"]
  P["E2 Person: per organization, active or not"]
  L["E3 Linked login"]
  K["E4 Passkey"]
  S["E5 Session: in one organization"]
  T["E7 Person proof: names the organization"]
  R["E6 Relying service"]
  D -->|private: 1..n| O
  D -->|1..n| P
  O -->|0..n| A
  A -->|admits at most 1| P
  O -->|exactly 1 owner| P
  P -->|1..n| L
  P -->|0..n| K
  P -->|0..n| S
  S -->|belongs to exactly 1| O
  S -->|0..n| T
  T -->|exactly 1| R
```

## Requirements

| Id | Requirement | Needs | Entities | Problem → outcome · example | Proof |
| --- | --- | --- | --- | --- | --- |
| `R1` | For people, the service MUST offer exactly three sign-in methods: Google, GitHub, and a passkey the Person registered earlier. Agents sign in only with their own client credentials (`R15`). It MUST NOT offer email and password, magic links, any other provider, or an identity-proxy sign-in path. | U1 | E1–E4 | P1→O1 · C1 | V1 |
| `R2` | A new Person MUST first sign in with Google or GitHub (the default until `SD7` decides whether passkey-first registration is allowed). While signed in, a Person MAY register passkeys, and a later passkey sign-in MUST reach the same Person. | U1 | E2–E5 | P1→O1 · C1 | V1 |
| `R3` | In a private deployment, a Google or GitHub sign-in to an organization MUST reach or create a Person only when the provider-verified email matches one of that organization's allowed E8s. A passkey sign-in to an organization MUST start a session only for a Person active there. Otherwise the sign-in MUST end as "not allowed" with nothing created or linked. A sign-in that names no organization, or one the deployment doesn't register, MUST end the same way. | U2, U9 | E1, E2, E3, E4, E8, E12 | P2→O2 · C1, C5 | V2 |
| `R4` | When one of an organization's E8s is removed, the matching Person MUST be unable to start a new session in that organization by any method, including a passkey. The removal takes effect when it is recorded: every session creation in that organization, and every proof issuance and privileged-decision confirmation for a session of that organization, after that MUST be refused, including one that uses a session created while the removal was in progress. Existing sessions in that organization MUST stop being accepted for privileged decisions at once (`R9`), and for any other use within the token lifetime (bound `SD3`). The Person's sessions and standing in other organizations MUST NOT change. | U2, U9 | E2, E5, E7, E8, E12 | P2→O2 · C1, C5 | V3 |
| `R5` | In a public deployment, anyone MUST be able to register, by the same first-sign-in rule as `R2`, and then add passkeys. Its People, sessions and proofs MUST NOT be accepted by a private deployment's relying services. | U3 | E1, E2, E7 | P4→O4 · C2 | V4 |
| `R6` | For each relying service that serves people (the console; Switchboard's control API), the service MUST issue an E7 that names the deployment, the Person's stable id, the relying service, the organization of the session it was issued during (in a private deployment) and an expiry. A workspace's MCP address serves agents only, and no E7 is issued for it. A relying service MUST refuse an E7 issued for another relying service or by another deployment. | U4, U9 | E1, E2, E6, E7, E12 | P3→O3 · C1 | V5 |
| `R7` | An E7 MUST stand for a Person. A credential identifying a service, machine or agent MUST NOT be issued as, or accepted as, an E7. | U4, U6 | E6, E7 | P3→O3 · C1, C3 | V5 |
| `R8` | Linking a second Google or GitHub login to a Person MUST be an explicit action by that signed-in Person. It MUST NOT happen because email addresses match. If an unlinked login carries a verified email that already belongs to a Person, the sign-in MUST be refused with a "link it from your account" outcome, creating nothing. | U1, U4 | E2, E3 | P1→O1 · C1 | V6 |
| `R9` | When a relying service takes a privileged decision for a Person (Switchboard's Accept or Deny), it MUST be able to confirm at decision time that the Person is still active in the proof's organization and the session still current. A valid E7 signature alone MUST NOT be enough. The decision MUST take effect only while that confirmation is younger than the bound `SD8`; past it, the relying service confirms again or refuses. | U2, U4 | E2, E5, E7 | P2, P3→O2, O3 · C1 | V3 |
| `R10` | Machine, VM, VPN and personal-fleet access MUST NOT depend on this service, and this service MUST NOT issue proofs to machines or VMs. Agents sign in only as agents (`R15` to `R18`). | U6 | E1, E7 | boundary (U6), no problem row · C3 | V7 |
| `R11` | Each deployment MUST run on the owner's Cloudflare account with its own D1 database, with no third-party sign-in subscription. | U5 | E1 | P1→O1 | V8 |
| `R12` | Every change to who may sign in, or how, MUST be recorded with who made it, what changed, the organization it belongs to when it belongs to one, and when. That covers each organization's allowlist entries and owner binding; a Person's removal and reactivation in an organization; linked logins and passkeys added or removed; relying-service and client registrations and their authority. A change whose record cannot be written MUST NOT happen. Sign-in successes and refusals MUST be recorded, naming the organization signed in to, for its owner to review. Credentials, proofs and passkey material MUST NOT appear in any record. | U7, U9 | E2–E4, E6, E8, E12 | P2→O2 · C1 | V9 |
| `R13` | Signing out MUST end that session's ability to obtain new E7s. No proof-renewal grant may outlive the Person's sign-out. | U2, U4 | E5, E7 | P2→O2 · C1 | V3 |
| `R14` | Each organization's first administrator MUST be the person whose provider-verified email the deployment's operator configured as that organization's owner. No one else can become its administrator by signing in first, and until that person signs in to it, nobody else can sign in to that organization. | U2, U9 | E1, E2, E8, E12 | P2→O2 · C1, C5 | V10 |
| `R15` | An agent MUST sign in as itself, with its own registered credential, and receive an E10 for one workspace it has a linked E11 for. The E10 names the deployment, the agent's client id, the workspace's organization, the workspace and an expiry. A request for a workspace the agent isn't linked to, or for a workspace of another organization, MUST be refused. A relying service MUST refuse an E10 issued for another workspace, including another workspace of the same organization. | U8 | E6, E9, E10, E11 | agent sign-in, C4 | V11 |
| `R16` | An E10 MUST NOT be issued as, or accepted as, an E7, and an E7 MUST NOT be accepted where an E10 is required. | U8, U4 | E7, E10 | C4 | V11 |
| `R17` | When an E9 is removed (the agent is retired), it MUST be unable to obtain new E10s for any workspace at once, and a relying service that checks its own record on every call (Switchboard does) MUST refuse that agent on its next call. | U8 | E9, E10 | C4 | V11 |
| `R18` | When an agent is unlinked from one workspace, it MUST be unable to obtain new E10s for that workspace at once, including a request in flight when the unlink is recorded. Its E10s for its other linked workspaces MUST keep being issued, and its E9 MUST stay active. An E10 issued for that workspace before the unlink stays valid until it expires; the workspace refuses its calls through its own membership check (Switchboard check 14). | U8 | E9, E10, E11 | C4 | V12 |
| `R19` | Admission, removal, ownership and their records in one organization MUST NOT change another organization's. A session, an E7 or an owner's authority in one organization MUST NOT be accepted for any action in another, including its administration, its Switchboard decisions and its agents; a relying service MUST refuse an E7 that names a different organization from the one the action belongs to. A Person admitted to two organizations signs in to each separately. | U9, U2 | E2, E5, E7, E8, E12 | P5→O5 · C5 | V13 |
| `R20` | Only an organization's owner, signed in to that organization and active there, MAY list or change its E8s, read its records, or register, link, unlink or retire its agents (E9, E11). Anyone else MUST be refused with nothing changed and nothing revealed, including a member of that organization, another organization's owner, an agent, and an owner whose own entry was removed. | U9, U2, U8 | E2, E8, E9, E11, E12 | P5→O5 · C4, C5 | V14 |

## Worked examples

### C1 — Private deployment, one organization

Setup: the operator deploys and registers organization O1 with `owner@example.test` as its owner. Alice's sign-in to O1 is refused, because O1 admits no one until its owner arrives. The owner signs in to O1 with Google using that verified address and becomes its administrator; the record shows the binding (`R14`).

1. The owner adds `alice@example.test` to O1's allowlist. The record shows the owner, O1, the added address and the time.
2. Alice signs in to O1 with Google using that verified address and becomes Person A; Bob, whose address is not listed, ends at "not allowed", and nothing is created for him.
3. Alice registers a passkey, signs out, and signs back in to O1 with the passkey: she is Person A again.
4. Alice also has a GitHub account with the same verified email. Signing in with it is refused with "sign in your usual way, then link GitHub", and nothing is created or linked. Only after Alice, signed in, links GitHub explicitly does a GitHub sign-in reach Person A.
5. The console receives a proof for the console, naming O1. Switchboard refuses that proof. The console obtains a proof for Switchboard on Alice's behalf, naming O1, and Switchboard accepts it for O1.
6. The owner removes Alice from O1. Her next Accept in Switchboard is refused at once. Her passkey no longer starts a session in O1, and her other use stops within the token lifetime.

### C2 — Public deployment

Carol registers with GitHub on the public deployment and adds a passkey. A proof from the public deployment is refused by the private deployment's Switchboard, even if Carol's email is on the private allowlist.

### C3 — Machines

A VM reaching the personal fleet over the VPN, and a machine calling the Router, go through Cloudflare. Neither ever receives or presents a proof from this service.

### C4 — Agents

O1's owner (only the owner, `SD9`) adds the home agent to workspaces W1 and W2 of organization O1, and gives its credential to the agent's host, never to a tool call. A member of O1 who tries the same is refused, and nothing is created.

1. The agent signs in with that credential and asks for a proof for W1. W1's address accepts it; W2's refuses it. It asks for W2 and gets a proof W2 accepts.
2. A request for W3, a workspace of organization O2, is refused, and so is one for a workspace of O1 it was never added to.
3. The console refuses its proofs, and so does any check that needs a person.
4. The owner removes the agent from W1. Its next call on W1 is refused, and its request for a new W1 proof is refused. A new W2 proof is issued, and a call with it runs once.
5. The owner retires the agent. Every token request fails, and W2 refuses its next call.

### C5 — Two organizations in one deployment

Setup: the operator registers O1 with Olive as its owner and O2 with Bob as its owner. Both have signed in to their own organization. Olive adds `alice@example.test` to O1's allowlist, and Bob adds the same address to O2's.

1. Alice signs in to O1 and gets a proof for Switchboard naming O1. Switchboard accepts it for a decision in O1 and refuses it for a decision in O2.
2. Alice signs in to O2 separately, with the same Google login or passkey: she is the same Person, and this session's proofs name O2.
3. Bob can't list or change O1's allowlist, read O1's records or manage O1's agents, and Olive can't do any of that for O2. Alice, a member of both, can do it for neither. Each attempt is refused, and nothing changes.
4. Olive removes Alice from O1. Alice's O1 session and her next Accept in O1 are refused, and she can't sign in to O1 again. Her O2 session, its proofs and her decisions in O2 keep working.
5. A sign-in to an organization the deployment doesn't register is refused, and nothing is created.

## Failure behavior

| Situation | What the person or service sees |
| --- | --- |
| Google or GitHub is unavailable or the sign-in is cancelled | sign-in fails with a reason; nothing created |
| The provider returns an unverified email in a private deployment | "not allowed" |
| A passkey assertion fails or uses a removed passkey | sign-in fails; no session |
| A relying service receives an expired, wrong-audience or wrong-deployment proof | refused |
| The service cannot reach its database | no new sessions or proofs; relying services keep refusing what they cannot verify |
| The service cannot read one organization's admission state | no new sessions, proofs, live-check confirmations or administration for that organization; each is refused, never accepted. Other organizations keep working |
| A sign-in names no organization, or one the deployment doesn't register | "not allowed"; nothing created |
| A privileged decision cannot confirm current status | the decision is refused, not accepted |
| A first sign-in is refused, and the records it created can't be deleted because the database fails or the service stops mid-request | those records stay unbound and inactive: they can't start a session or obtain a proof, and the failure is recorded for the owner |
| A removal is recorded while a sign-in or a decision in that organization is in progress | a session the sign-in creates can't be used for anything; the decision takes effect only if its confirmation came before the removal and is still within `SD8`, otherwise it is refused |

## Cross-cutting obligations

- **Security:** only the three methods (`R1`); explicit linking only (`R8`); per-service proofs (`R6`); current status for privileged decisions (`R9`); no secrets in records (`R12`); organizations kept apart (`R19`); only an organization's owner administers it (`R20`).
- **Privacy:** a deployment stores only what sign-in needs: the provider account ids, verified email, display name and passkey public keys. It stores no biometrics. An organization's allowlist and records are visible only to its owner (`R20`).
- **Reliability:** if the service is down, people can't sign in, and services refuse unverifiable proofs (fail closed).
- **Cost:** `R11`; the Free plan only when measured CPU fits (`SD6`).
- **Accessibility:** the sign-in screens are an open UI view to define with the UI design (F-56). Until then, `no current UI`.

## Proof obligations

| Id | What must be distinguishable from a wrong build | Reference and target |
| --- | --- | --- |
| `V1` | Only Google, GitHub and a registered passkey sign a person in. Any other path is absent. A passkey sign-in reaches the same Person. | C1 steps 2–3; a deployed private deployment |
| `V2` | An email not on the organization's list, or unverified, creates or links nothing, even when another organization lists it; a sign-in naming no organization or an unregistered one creates nothing. | C1 step 2, C5 step 5; private deployment |
| `V3` | After removal from an organization or sign-out, a privileged decision in that organization is refused at once and new sessions and proofs there stop. Other use stops within the token lifetime. The Person's other organizations are unaffected. | C1 step 6, C5 step 4; the real Switchboard decide path |
| `V4` | Public and private deployments never accept each other's people or proofs. | C2; two deployments |
| `V5` | A proof is accepted only by the service it names, from its own deployment, and only when it stands for a person. | C1 step 5; console and Switchboard |
| `V6` | Matching emails never link or duplicate a Person, and the refusal says how to link. Explicit linking does link. | C1 step 4 |
| `V7` | Machine and VM access works with the sign-in service absent, and no machine holds a proof. | C3 |
| `V8` | Each deployment runs on the owner's Workers with its own D1, with no external sign-in vendor. | deployment configuration |
| `V9` | Each change `R12` lists has its record, and a change whose record can't be written doesn't happen. No record contains a credential or proof. | C1 step 1 and every change kind in `R12`, with planted test secrets |
| `V10` | In an organization whose owner hasn't signed in yet, only the configured owner's verified email can sign in to it, and that person becomes its administrator; any other first arrival is refused. | C1 before step 1; a freshly registered organization |
| `V11` | An agent's proof is accepted only at the workspace it names, never at another workspace, even in the same organization, and never as a person's proof; a person's proof is never accepted as an agent's; no proof is issued for a workspace the agent isn't linked to or for another organization's; a retired agent gets no new proof and is refused on its next call. | C4 steps 1–3 and 5; Switchboard's Worker caller check |
| `V12` | After an agent is unlinked from one workspace, a new proof for that workspace is refused, including a request held in flight while the unlink lands, while a new proof for its other workspace is issued and works once, and its client stays active. | C4 step 4; a local runtime for the held request |
| `V13` | With two organizations in one deployment and one Person admitted to both, admission, removal and ownership changes in one leave the other's sessions, proofs, decisions and records unchanged, and a proof naming one is refused for the other's actions. That holds while a removal in one is in flight and while the other's admission state can't be read. | C5 steps 1, 2 and 4 |
| `V14` | Only the organization's active, signed-in owner can list or change its allowlist, read its records or manage its agents; a member, the other organization's owner, an agent and an owner whose entry was removed are each refused, with nothing changed and nothing listed. | C5 step 3; C4 setup |
