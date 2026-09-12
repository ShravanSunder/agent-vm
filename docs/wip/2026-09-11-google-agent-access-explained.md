# Google access: who gets access, who decides, and when we ask

**Purpose:** a shared explanation for the household system, not an implementation plan or a claim that the whole flow is proven.

**The key distinction:** Google authorizes a Google account's access to our Google application. Our system decides which agent may use a connected account, for which operations, and whether to ask before a particular operation. Google does not know that Sun, Mak, or Ember exists.

**Decision for now:** do not use an additional operator-configured per-agent OAuth maximum. The updated configuration examples use `all-supported`, making the required compatibility ceiling non-narrowing. The schema field still exists; deleting it is deferred. Google consent, account policy and supported-command checks remain mandatory.

Start with [the two sides](#1-the-two-sides-of-the-boundary), [the dimensions](#3-the-dimensionsnot-one-giant-permission-matrix), and [who owns what](#7-which-system-owns-which-responsibility). The later examples explain the tricky cases.

## 1. The two sides of the boundary

```text
GOOGLE'S SIDE                         OUR SYSTEM'S SIDE

Google account                       Human signed into our website
       |                                    |
       | consents to scopes                 | connects an account for an agent
       v                                    v
Google application                   Agent + Google account + integration
(Cloud project / OAuth client)              |
       |                                    | saved Read/Write policy
       | issues scoped credentials          v
       +----------------------------> Credential broker + Tool Portal
                                            |
                                            | authorized operation only
                                            v
                                      Credentialed Gog execution
                                            |
                                            +----> Google API

Google recognizes the account, application/client, token and scopes.
Our system recognizes the human owner, agent, selected account and operation.
An agent name in our database does not become a Google consent boundary.
```

This picture leaves out networking and storage, which are explained separately below. The broker/controller is trusted infrastructure. In the configured HTTP-mediated Gog path, the execution VM gets an opaque placeholder; the host supplies the real access token only on permitted API requests. The refresh token stays in the broker. This is our enforcement boundary, not a Google-recognized agent identity.

## 2. The nouns: these are different things

| Name | What it actually means | What it does not mean |
| --- | --- | --- |
| Human website identity | The person Clerk authenticated. Our owner identity uses verified issuer plus Clerk user ID. | A Google resource grant; or the identity of an agent. |
| Google account | The resource account whose Gmail, Calendar, files, etc. may be accessed. Google identifies it by its subject identifier. | An OAuth app; or an agent. An editable nickname does not change this account. |
| Google Cloud project | Google's container for the logical application, API configuration and related client registrations. | A household member or agent. |
| OAuth client | A registered component of that Google application, with a client ID, client secret and callback configuration. | Proof of independent consent isolation from other clients in the same project. |
| Scope | A Google-defined permission such as Gmail read-only. | Our Ask/Allow setting; or an exact Gog command. |
| Google consent/grant | The human's authorization for the Google application to access that Google account with granted scopes. | Permission for a named agent, or permission to all Google accounts. |
| Access token | A credential used on API requests, carrying a scope set and subject to expiration and provider rules. | A per-call user approval. |
| Refresh token | A credential the broker can use to obtain later access tokens. | An independently revocable per-agent grant merely because it is stored in a different row. |
| Integration | Our configured grouping of services and its Google client binding, such as `gmail-app`. The code calls this an application ID. It can be shared by agents. | A per-agent connection or policy row. |
| Agent connection | Our record for **agent + Google account + integration**, with its credential material and owner-confirmed access. The code calls this an authorization record. | A Google-native agent identity. |
| Saved account policy | Our Read and Write rules for that connection's services: Deny, Ask or Allow. | Another identity provider or a second consent at Google. |
| One-call approval | Permission for the specific pending operation when its policy is Ask. | A policy edit, a new connection, or additional Google scopes. |

Google explains the project/client distinction and shared application trust in its [cross-client identity documentation](https://developers.google.com/identity/protocols/oauth2/cross-client-identity?hl=en). Our account/connection distinction is visible in [the catalog schema](../../packages/oauth-broker/src/catalog-schema.ts).

### What does our integration name mean?

The repository's shipped example uses these logical bindings; the service family is configuration, not a meaning enforced by the English name:

| Our integration ID | Services grouped under it |
| --- | --- |
| `gmail-app` | Gmail, Calendar, Contacts |
| `workspace-app` | Drive, Docs, Sheets, Slides, Forms |
| `youtube-app` | YouTube |

The shipped example places all three integrations in one Google project, `example-project`. Different service groups therefore do **not** imply different Google consent/revocation boundaries. Actual deployments can choose different project mappings.

These IDs select configured Google client/project bindings and a service catalog. Their names do not themselves determine which scopes are granted, whether Google projects are separate, or which agents get access. Calling a group “Gmail” does not make Calendar a different OAuth app. See [the catalog](../../packages/oauth-broker/src/google/google-permission-catalog.ts) and [client configuration schema](../../packages/config-contracts/src/oauth-config.ts).

## 3. The dimensions—not one giant permission matrix

Different decisions have different keys. Putting all of them on the same two-axis grid is what made the earlier explanation misleading.

| Decision | Dimensions it depends on | Authority |
| --- | --- | --- |
| Reach the private website | Device/network identity + destination | Tailscale/network configuration |
| Sign into the website | Clerk issuer + human user + current session | Clerk, verified by our server |
| Send requests to an agent | Messaging user/channel or API credential + target agent | Gateway/channel admission, separate from website login |
| Manage an account for an agent | Human owner + target agent/account; configured editor rights | Our controller |
| Grant Google API access | Google account + Google application/client + requested/granted scopes | Google and the consenting Google account user |
| Make a connected account usable by an agent | Household/zone + agent + account + integration | Our broker's connection record |
| Decide whether a call needs approval | That connection + service + Read/Write effect | Tool Portal's effective account policy |
| Approve one call | Exact pending operation, arguments, account and current authorization context | Existing approval system and eligible approver |

**The everyday settings matrix is only:**

```text
Agent  ×  Google account  ×  Service  ×  Read or Write
                                           |
                                           +-- Deny / Ask / Allow
```

Internally the zone (the configured deployment grouping for these agents/accounts) and integration also bind the record. The human owner controls editing; the owner is not another Read/Write setting. The provider token has its own scopes; those are not another Ask/Allow axis. [Section 10](#10-current-implementation-versus-the-agreed-simplification) explains the non-narrowing compatibility setting retained by the schema.

### A concrete settings page

For **Ember → your personal Google account**:

| Service | Read | Write |
| --- | --- | --- |
| Gmail | Allow | Ask |
| Calendar | Ask | Deny |
| Contacts | Deny | Deny |

This is an illustrative choice, not a claim about today's beta defaults or available commands. For each row, Read and Write are independent. There are nine possible pairs because each can be Deny, Ask or Allow—not just four quadrants.

“Write allowed” does not automatically set local Read to Allow. If a supported command needs both effects, both cells must permit it. Any Deny blocks the command; otherwise any Ask requires approval. All-Allow permits execution without a per-call prompt. See [the policy evaluator](../../packages/tool-portal/src/google-account-policy.ts).

## 4. Recommendations, saved choices, and actual Google scopes

**Recommended means a starting point, never an unchangeable maximum.** There are two suggestions a recommendation collection can supply:

1. Suggested **Google access selections** for a consent request.
2. Default **local Read/Write policy** for future operations.

Those suggestions are related, but not interchangeable. Choosing Ask is not a Google scope. Granting a write-capable Google scope is not a standing instruction to perform writes.

```text
LOCAL POLICY, ONE CELL

Explicit saved choice in SQLite? ---- yes ---> use that Deny / Ask / Allow
                  |
                  no: “Use default”
                  v
        use configured default
        (missing default fails closed to Deny)

GOOGLE ACCESS, SEPARATELY

Suggested scopes -> owner's choice -> Google consent -> actual returned scopes
```

An explicit saved choice wins over a later default change. A cell left on “Use default” follows the newly activated configuration. The configuration is not live-reloaded merely because someone edits a file. Current activation uses the deployment workflow.

The built-in read-only collection selects read groups for covered services in each family—Gmail in communications, selected document services, and YouTube. It **sets the corresponding local Read policy to Allow**, so those reads need no per-call prompt. It defaults every Write cell to **Deny**, not Ask; unselected services also default to Deny.

If the **loaded, compiled defaults** do not match SQLite's active defaults snapshot—for example, during incomplete activation—the policy service fails closed as unavailable. That is not a fallback to old defaults. Editing a file alone does not change the running service.

Other examples in this document are choices the owner could make. [Default collection](../../packages/oauth-broker/src/google/google-policy-catalog.ts) · [Override format](../../packages/oauth-broker-contracts/src/google-account-policy-contracts.ts)

If policy allows a write but the account connection only has read scopes, the result is **additional Google consent required**, not execution and not a per-call approval that magically supplies scopes. Conversely, a token capable of writing cannot override local Write = Deny.

Google console setup declares the app's scope usage; it does not grant all those scopes to every person. Each OAuth request sends scopes, and our broker checks what Google actually returns. Google may return less than requested. A mismatch must not be silently presented as the requested access. Current code requires the returned scope set to match the confirmed selection. [Google authorization flow](https://developers.google.com/identity/protocols/oauth2/web-server?hl=en) · [Current confirmation check](../../packages/oauth-broker/src/google/google-authorization-commit.ts)

**Gmail caution:** a Google permission capable of drafting can also be capable of sending. “Draft only” must not be presented as a narrower Google token if Google provides no such scope. Local command support and policy may restrict use, but cannot rewrite a token's authority. [Current Gmail scope catalog](../../packages/oauth-broker/src/google/google-permission-catalog.ts)

## 5. Sun and Ember using the same Google account

```text
                YOUR ONE GOOGLE ACCOUNT
                           |
                  our Google application
                           |
                Google-scoped credentials
                           |
                  OUR TRUSTED BROKER
                    /             \
        Sun + this account       Ember + this account
        separate local binding   separate local binding
        separate local policy    separate local policy
```

For the same configured integration, Sun and Ember use **the same Google client ID**: configuration selects the client by integration, not by agent. Google sees the same application asking the same account again—not a Google app for Sun and another for Ember. [Client selection in the broker](../../packages/oauth-broker/src/google/google-authorization-commit.ts)

The diagram does not assert that both agents share one token or that Google creates two isolated grants. Current storage holds credential material per agent connection. The important point is which system owns the separation.

Suppose you connect this account to Sun and Ember, then permit Sun to write while Ember remains read-only:

- Sun's local policy change does not edit Ember's policy row.
- If Sun needs additional Google scopes, that is a Google authorization request by our application for your account—not a request by a Google-recognized “Sun” identity.
- Ember's local Write = Deny must still be enforced, regardless of the breadth of a credential.
- We must not infer that Ember's Google credential remains independently narrow merely because the database has separate records.

**What Google documents:** incremental authorization can produce a combined authorization containing scopes previously granted to the API project, even through different client IDs. A refresh token for that combined authorization can obtain tokens for that combined scope set. Revoking a token representing that combined authorization revokes its combined scopes together. [Google's incremental authorization rules](https://developers.google.com/identity/protocols/oauth2/web-server?hl=en#incrementalAuth)

**What that does not prove:** it does not say every older access token automatically broadens when another consent occurs. It also does not establish independent revocation from separate refresh-token strings. Current broker requests omit `include_granted_scopes`; the raw endpoint documentation does not establish an omitted-value default. We have not completed a same-account multi-agent grant/refresh/revocation qualification. [Actual request builder](../../packages/oauth-broker/src/google/google-oauth-adapter.ts)

Therefore the promised agent separation is **our broker and Tool Portal enforcement**, with checked token scopes as an additional constraint—not an unproved Google per-agent grant boundary. A compromised trusted controller or someone with full host-and-key access is outside what these local policy checks can contain. Stronger provider isolation would need a separately justified design; it is not created just by naming clients after agents.

### Ember shared by two people

Ember can have a connection to your Google account and another to your wife's account. They are different account rows, different agent–account bindings, and different policies. You may permit reads on yours; she may require approval on hers. Her consent does not connect your account, and your policy edit does not change hers.

**Sharing an agent is not the same as per-person data isolation.** This matrix controls what Ember may do; it does not itself mean “only the account owner may ask Ember to use this account.” Who may send requests to Ember is a separate Gateway/channel-admission concern. Do not infer per-human confidentiality inside a shared agent from this account-policy matrix alone. The current policy lookup is keyed by the trusted agent and selected account, not by the human who wrote the chat message. [Policy lookup inputs](../../packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts)

**Accepted household behavior:** anyone admitted to use Ember may ask it to use Ember's connected accounts, subject to each account's consent and Read/Write policy. Account ownership restricts managing access, not which admitted chat participant can request an operation.

Current policy editing requires three things: **this human owns the account**, **owner configuration admits that human to the target agent**, and **editor configuration permits that human to edit that agent**. These are who-may-manage checks, not OAuth scope maxima. Being an editor for Ember alone does not let you edit your wife's account policy. This is distinct from who may approve one invocation; eligible approvers are configured through the existing approval-access system. [Owner/editor checks](../../packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts)

## 6. One read request, from agent to Google

```text
Ember requests a supported command for a selected account
       |
       v
Our system establishes the caller's agent identity
and checks that agent's connection to that account
       |
       v
Check command shape, owner-confirmed access and usable Google scopes
       |
       v
Resolve required Read/Write cells: saved choice, otherwise default
       |
       +-- Deny ----------> stop
       +-- Ask -----------> eligible person approves this exact call
       +-- Allow ---------> no per-call prompt
                                |
                                v
                 Recheck current authority, then broker-mediated Gog call
                                |
                                v
                     Google enforces the credential's scopes
```

A local Deny blocks the call; missing Google scopes do not turn that Deny into a consent prompt. If policy is Ask but scopes are missing, consent is required **before** a one-call approval can allow execution.

This is a responsibility diagram, not a claim that every implementation check runs in this exact order. Missing consent, unsupported commands, expired credentials and denied policy are distinct outcomes. An agent cannot gain another agent's access by supplying its name or a guessed account ID: the controller checks the trusted caller and matching connection. [Invocation checks](../../packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts) · [Final dispatch authority](../../packages/agent-vm/src/controller/control-session/gateway-control-controller-execution-authorization.ts)

## 7. Which system owns which responsibility?

| System | Owns | Does not own |
| --- | --- | --- |
| Tailscale | Network admission to the private website | Google scopes or account Read/Write policy |
| Clerk | Human login/session identity; Google sign-in for our website | Our agent resource-token vault or agent policy |
| Google | Resource-account consent, scope semantics, token issuance and provider revocation | Our agent names, account policies or one-call approvals |
| Controller/broker | Verified account connection, credential custody/refresh, agent–account binding and enforcement | The meaning of Google's scopes |
| Tool Portal | Supported command exposure, effective call policy and routing into approval/execution | Manufacturing Google consent |
| Website | Owner-facing connection, account confirmation and policy-editing interface | Trusting browser-supplied owner identity or silently granting access |
| Existing approval system | Approval of an exact pending operation by an eligible approver | Persistent policy edits or new OAuth scopes |
| Agent | Requests an operation for an available account; may request owner authorization | Editing its own access or handling the human's Clerk session |

“Clerk is login only” means **we do not use Clerk's social tokens for Gog**. Clerk may itself retain the credentials needed for its Google login connection. Those are distinct from resource credentials managed by our broker. Signing into Clerk with Google is not the same as connecting Gmail to Sun. [Browser identity boundary](../specs/2026-09-04-agent-account-and-tool-permissions/browser-identity.md)

## 8. What is configured, and what is stored in SQLite?

| Item | Authored/stored where | Who changes it |
| --- | --- | --- |
| Google clients, integration bindings, network and human owner/editor admission | Deployment configuration; client secrets in 1Password | Operator |
| Available tool commands and recommendation/default collections | Code catalog plus Tool Portal configuration | Operator/code maintainer |
| Google account identity and human ownership | Controller SQLite account record | Verified account connection workflow; not an editable alias |
| Agent connection and resource credentials | Controller SQLite; credential payload envelope-encrypted | Broker after owner confirmation |
| Per-service Read/Write overrides | SQLite; override snapshot encrypted and bound to its connection | Account owner who is also an admitted agent editor, through website |
| Active defaults snapshot and change history | SQLite, alongside authored defaults in config | Controller records activation/history; not a second user-editable default source |
| One-call approval state | Existing controller approval storage | Existing approval flow |
| Envelope wrapping key | 1Password, loaded by trusted controller | Operator |

“Envelope-encrypted” means the payload is encrypted with a data key, and that data key is itself protected by the wrapping key held in 1Password.

SQLite encryption protects stored material; it does not replace identity, ownership, command, or policy checks. **It does not hide all metadata:** account/agent references, account label (currently the verified Google email), editable account nickname, client ID, requested/granted scopes, selected access groups and lifecycle fields also exist as plaintext columns. Those can be private even though they are not tokens. Credential payloads and policy override snapshots are envelope-encrypted, with authenticated bindings checked before use. Some authority metadata, including the nickname, also has an authenticated copy inside the encrypted payload; that does not hide its plaintext column. [Storage tables](../../packages/oauth-broker/src/catalog-schema.ts) · [Policy writes](../../packages/agent-vm/src/controller/oauth/google-account-policy-editor.ts)

## 9. Three different “stop access” actions

| Action | Effect | Not a promise of |
| --- | --- | --- |
| Set a cell to Deny | Stops relevant operations under our local policy | Revoking Google's app consent |
| Disconnect this agent's account connection | Blocks further local use of that connection and stops its runtime credential use | Revoking every provider grant or other agent connection |
| Revoke the app's access at Google | Changes provider-side authorization; can affect other uses of the same application/account | Removing just one agent's permission |

The current local disconnect implementation does not call Google's revocation endpoint. It removes the credential payload from the active connection row while blocking further local use. The broker cannot later revoke using that row's removed refresh token; the account owner can still revoke the application's access directly at Google. Removing a row's payload is not a promise of secure erasure from backups or all prior copies.

Google's current documentation is stronger than “revocation might be shared”: its revocation **Key Point** says it removes the project's previously granted scopes and invalidates issued access/refresh tokens for all clients registered under that project. This concerns that account's application authorization, not all household members' accounts. Do not offer Google revocation as “disconnect only Ember.” [Local disconnect](../../packages/oauth-broker/src/google/google-authorization-disconnect.ts) · [Google revocation](https://developers.google.com/identity/protocols/oauth2/web-server?hl=en#tokenrevoke)

**Connection expired or needs reauthorization?** Reconnect/reauthorize it through the website; a local Allow setting cannot repair an expired or revoked Google credential. If it reports unavailable or degraded rather than asking for consent, the operator needs to inspect the reported state instead of treating a policy edit as a repair.

**Wrong account selected?** For a new resource connection, Google returns the selected account; our confirmation screen shows it before attaching it to the agent. Cancel and start again if it is wrong. Cancel does not imply Google has undone consent already given. Reauthorization of an existing connection must not silently swap to a different Google subject. The Google account used for website sign-in and the Google resource account you connect **may be different**. The invitation's same-email sign-in rule is about website login, not a rule that every connected resource account must have that email. Website login remains a different identity flow with invitation/owner checks. [Account confirmation checks](../../packages/oauth-broker/src/google/google-authorization-commit.ts)

## 10. Current implementation versus the agreed simplification

| Item | Current code | Intended model for now |
| --- | --- | --- |
| Additional per-agent OAuth maximum | Schema field remains; updated examples use non-narrowing `all-supported` | **Do not use an extra restriction. Field deletion is deferred.** |
| Recommendation | Suggested consent selections and local defaults | Keep editable; never interpret as a maximum |
| Saved owner policy | Connection-specific overrides in SQLite | Keep Deny / Ask / Allow, independently for Read and Write |
| Supported/configured command set | Determines available operations | Keep; label unavailable functionality honestly |
| Human ownership/editor rights | Required to manage a connection | Keep; not an extra OAuth scope maximum |
| Google consent and actual token scopes | Required for resource access | Keep; not replaceable by local Allow or a one-call approval |

Today the effective offered access is computed from **the configured ceiling and the operations reachable through configured commands**. The compiler rejects inconsistent commands, recommendations and defaults. The current schema requires the ceiling field: deleting it needs code changes. The updated examples use the existing `all-supported` preset to make it non-narrowing while retaining command restrictions. Older deployments must activate the updated configuration; this is not a runtime bypass of their existing settings. [Compiler](../../packages/config-contracts/src/oauth-tool-portal-config.ts) · [Catalog presets](../../packages/oauth-broker/src/google/google-policy-catalog.ts)

**Do not confuse not using the extra maximum with exposing every Gog command.** An unimplemented command is unavailable functionality. A configured supported command may still be forbidden by the owner's Deny. Neither is a recommendation.

The [updated OAuth example](../reference/configuration/examples/oauth-v2.config.jsonc) uses `all-supported`; its [paired Tool Portal example](../reference/configuration/examples/tool-portal-google-policy.config.jsonc) exposes all 15 catalog-supported Gmail, Calendar and Contacts commands. All six Read/Write access groups are therefore available as choices. The examples preserve their existing defaults: Calendar, Contacts and Gmail writes remain Deny. Making a choice available does not grant Google access or authorize an operation. The [example integration test](../../packages/config-contracts/src/oauth-config-examples.integration.test.ts) verifies both availability and unchanged defaults.

## 11. Check our understanding with these questions

1. **If Sun gets write access, did Google grant it to “Sun”?** No. Google granted scopes to the application for that account; our system binds their permitted use to Sun.
2. **Can Ember use an account connected only to Sun?** Not through the broker: Ember needs its own local agent–account binding.
3. **Can Write = Allow overcome a read-only Google connection?** No; additional resource consent is needed.
4. **Does approving one write turn Write = Ask into Allow?** No; a policy edit is a separate action.
5. **Does a new default replace an explicit saved choice?** No. It affects inheriting cells, not explicit overrides.
6. **Does Disconnect for Ember revoke Google's application grant?** Not in the current local disconnect path; Google-side revocation is different and may be broader.
7. **Are two credential rows proof of two isolated Google grants?** No. That provider-level guarantee has not been established.

The extra maximum is not used in the updated setup. Deleting its compatibility field and qualifying provider-level multi-agent grant behavior remain separate future work. Any later administrator maximum would be a new, explicit decision rather than a hidden consequence of Recommended.
