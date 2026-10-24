# Journeys: the fleet model end to end

Each journey follows one real situation through the design. It names who acts, what is checked at each step and by which component, the outcome, and what isn't built yet. It answers the owner's "where the coenpt walkTthoruhgs that show journesys?" (O79).

- Diagrams for each journey: [journeys.html](journeys.html).
- Rules referenced: [concepts.md](concepts.md).
- Marks: ✅ decided · 🟡 proposed · ❓ open (call letter or T-n in [decisions-and-open-questions.md](decisions-and-open-questions.md)).

**The cast used throughout:**

| Who | What |
|---|---|
| You | admin; person; owner of the `shravan` personal workspace; member of `household` |
| Your wife | person; owner of the `wife` personal workspace; member of `household` |
| `shravan` workspace | your Gmail and GitHub; your Mac (execution unit); personas `codex-worker`, `mail-assistant`, `chief-of-staff` |
| `household` workspace | family calendar; household board; household VM (execution unit); personas `household-agent`, `muse` |
| Backbone | registry, leases, mail, inbox, sign-in, push (agent-collaboration central) |
| Cloud MCP gateway, computer MCP on your Mac, credential broker | agent-vm |
| AgentStudio Host on each execution unit; Gateway apps on your Mac and iPhone | AgentStudio daemon |

**Journeys:**
1. [J1](#j1-add-the-household-vm-to-the-fleet): add the household VM to the fleet
2. [J2](#j2-start-coding-agents-on-your-mac): start coding agents on your Mac
3. [J3](#j3-an-agent-sends-email-and-you-approve-on-your-phone): an agent sends email and you approve on your phone
4. [J4](#j4-grok-as-your-chief-of-staff): Grok as your chief of staff
5. [J5](#j5-muse-on-the-household-board-talk-only): Muse on the household board, talk only
6. [J6](#j6-the-household-agent-uses-your-shared-calendar): the household agent uses your shared calendar
7. [J7](#j7-a-mac-tool-through-the-cloud-and-a-lost-reply): a Mac tool through the cloud, and a lost reply
8. [J8](#j8-requests-that-must-be-refused): requests that must be refused
9. [J9](#j9-revoking-things): revoking things
10. [J10](#j10-a-host-offline-for-five-hours): a Host offline for five hours

---

## J1. Add the household VM to the fleet

**Goal.** A new VM becomes the household's execution unit, so household agents can run there and nowhere else.

1. You (or whoever call E names) create the VM. ❓ call E
2. The VM's Router installation and AgentStudio Host ask the backbone to join and show a short code. The VM generated its own machine credential; it sends only a hash. 🟡 (current one-core design §0a)
3. The backbone raises an **enrollment sign-in** (✅ D-8). Push wakes your iPhone.
4. Your iPhone app, authenticated as your enrolled device, shows "Join household VM to workspace household?". You approve.
5. The backbone records the machine, its Access service client and its boundary (`household`). It returns a PeerId and expiry, never a secret. 🟡
6. The VM's services register under it (Router installation, Host, and a computer MCP service if it offers tools).

**Outcome.** The VM belongs to `household` only (✅ D-15). Its files, logins and caches are household's.

**Not built yet:**
- clone fencing (T-7);
- any central-issued machine credential (T-10);
- provisioning owner (call E).

## J2. Start coding agents on your Mac

**Goal.** Ten `codex-worker` agents start without you doing anything per agent.

1. Your Mac's AgentStudio Host (a launcher) starts ten Codex harnesses.
2. For each, the Host proves itself to the backbone and asks to enroll an agent under persona `codex-worker`. ✅ D-6
3. The backbone checks the launcher is allowed for `codex-worker`, the persona's workspace is `shravan`, the Mac's boundary is `shravan`, and the count and time limits. 🟡 · ❓ T-5
4. It issues each agent an ID (`codex-worker#01a…`) and a short-lived credential; the Host hands it to that harness. The agent renews while running. 🟡
5. One agent reads your Gmail through the cloud gateway:
   - Access admits the Mac's service client.
   - The gateway checks the agent's credential, then the persona's slice: Gmail read = approved.
   - Gmail is your resource, registered in `shravan`.
   - The broker uses your Gmail credential; the agent never sees it.

**Outcome.** Ten enrolled agents with no per-agent action from you; reading Gmail runs without a prompt.

**Not built yet:**
- agent credentials in the backbone;
- carriage of the agent credential through Cloudflare (T-1);
- persona-level grants in agent-vm, which today grants per agent ID (`allowedAgentIds`).

## J3. An agent sends email and you approve on your phone

**Goal.** One send, approved by you once, executed once.

1. `mail-assistant#04a` calls `gmail.send` with operation ID K. 🟡
2. The resource checks the slice (send = requires approval, ✅ D-9) and the approvers from your policy (you) (council C-a). It records K as pending, with the exact call, who asked and the expiry.
3. The approval request goes to the backbone inbox, which **carries and shows** it. Push wakes your phone (content is not in the push). 🟡
4. Your iPhone app fetches the request as your enrolled device and shows the exact email. You tap Approve; your device signs the answer.
5. The decision owner records the decision. ❓ D3 (T-3)
6. The agent continues K (retry or automatic, per D3). The resource re-checks the decision, the current policy and the requesting issuance, uses the approval **once**, and sends.

**Outcome.** One email. A retry of K never sends twice; a second, intentional identical email needs a new K.

**Variants:**
- You don't answer before the deadline → "not approved: timed out"; the agent continues without sending.
- You hand it back → the agent decides without the send.

**Not built yet:**
- the D3 protocol;
- authenticated answers in agent-collaboration (today it compares a supplied identity);
- a fresh-gesture option such as Face ID (T-9).

## J4. Grok as your chief of staff

**Goal.** Grok coordinates your coding agents without gaining their access.

**Assumption:** Grok is xAI-hosted, which makes it an external agent (❓ call K). If Grok runs in your own harness, step 1 becomes launcher enrollment as in J2.

1. You register external agent `grok` under persona `chief-of-staff` in `shravan`, and configure its credential on xAI's platform. ✅ D-11
2. **Collaboration profile** (agent-collaboration):
   - read and post on your boards;
   - message your coding agents;
   - may request "status" and "summarize" from `codex-worker`;
   - may request "take this task", with your approval;
   - may start new coding agents, with your approval.
   🟡 call F
3. **Tool profile** (agent-vm): calendar and Gmail read approved; Gmail send requires approval; GitHub blocked. 🟡
4. Grok asks `codex-worker#01b` to take a task. Checks:
   1. May Grok request "take this task" from `codex-worker`? Yes, with approval → you approve.
   2. `codex-worker` does the work with **its own** slice.
   3. The results go to your boards, the allowed audience.
   🟡 concepts §7.5
5. "Chief of staff" is a **skill role** (purpose) and grants nothing. If Grok should, for example, create workstreams on a project, that needs a Router role assignment (E11) on the concrete Grok agent, never on the persona. Access to boards doesn't confer it. 🟡 (existing Router contract)

**Outcome.** Grok can coordinate, read your calendar and email, and ask your agents for listed actions. It never uses their GitHub access, never reaches the household or your wife's workspace, and never acts as you.

**Not built yet:**
- per-call correlation on xAI's platform, so approval-gated tools are unavailable to Grok at first (T-8);
- agent-collaboration authenticated callers and per-persona board grants.

## J5. Muse on the household board, talk only

**Goal.** Meta's Muse talks with household agents but has no tool access.

1. A household owner registers external agent `muse` under persona `muse` in `household`. ✅ D-11 · ❓ call C (either of you)
2. **Collaboration profile:** read and post on the household board; message household agents; request **no** actions. 🟡
3. **No tool profile and no MCP portal credential:** Muse cannot even connect to the portal. 🟡
4. Muse posts "add dinner Friday". `household-agent` reads it but doesn't act, because Muse may not request actions. If you want that, grant exactly "request add-calendar-event from `household-agent`". 🟡 call F
5. Everything on the household board is visible to Meta's platform. Your personal agents keep private-derived content off it. 🟡

**Outcome.** Muse talks and reads; it can't make anything happen and sees nothing outside the household board.

**Not built yet:**
- per-platform authentication for Muse (T-8);
- per-persona board grants in agent-collaboration.

## J6. The household agent uses your shared calendar

**Goal.** `household-agent` plans family events using your calendar, without touching anything else of yours.

1. You create a **share**: resource = your calendar; into = `household`; recipients = `household-agent` (named, ❓ call G); ceiling = read; expiry = none. 🟡
2. Household's owners give `household-agent` a slice that includes your calendar, within the ceiling.
3. `household-agent#03a` runs on the **household VM** (✅ D-15) and reads your calendar:
   - The gateway checks its persona, workspace, slice and the share.
   - The broker uses **your** credential, which never leaves your workspace's broker.
4. It writes the plan to the family calendar (household's own resource; approvals from household's policy, ❓ call C).
5. Anything it read can appear on the household board, where your wife sees it. Sharing into the household means agreeing to that. 🟡

**Outcome.** Read-only use of your calendar, run on household compute, with your approval policy.

**Revoking the share** stops future reads at the next check (T-6). It doesn't recall what was already read.

**Not built yet:**
- shares (agent-vm and backbone);
- Router workspaces as a confidentiality boundary.

## J7. A Mac tool through the cloud, and a lost reply

**Goal.** One effect, even when the Mac's reply is lost.

1. `codex-worker#01b` calls a Mac tool through the cloud gateway with operation ID K.
2. The gateway verifies the Access assertion, the agent credential and the persona's profile. It records the outer operation `(gateway, 01b, K)` with target = your Mac and inner key `(Mac, 01b, K)` **before** sending. 🟡 (agent-vm P16)
3. The gateway sends its own identity plus delegation for `01b`, this exact call, and its approval floor. 🟡 call I
4. The Mac verifies the gateway, the delegation and its own ceiling. It takes the stricter of the floor and its own mode, and raises at most one approval. 🟡
5. The Mac creates the inner operation and runs the tool. Its reply is lost.
6. The gateway (or a replacement) recovers by looking up `(Mac, 01b, K)`. It adopts the result and never runs the tool again. A late original reply can't undo a finished result. 🟡

**Outcome.** One effect; the agent sees the same result.

**Not built yet:**
- the whole cloud → Mac path;
- D1 (direct Mac access during a cloud outage) is unselected (T-15).

## J8. Requests that must be refused

| Situation | Outcome | Rule |
|---|---|---|
| You ask `household-agent` to summarize *your* email | refused: it has no access to your Gmail; use your own agent | ✅ D-17; it acts for the household only |
| Your wife's agent posts a request on the household board that your `codex-worker` can read | your agent may read it but doesn't act on it for her | ✅ D-17; a message is not permission |
| `codex-worker#01b` tries to read your wife's Gmail | refused: not in `shravan`, not shared | 🟡 §5.3 |
| A test agent that may message `mail-assistant` asks it to email workspace files to an outside address | refused: may message, may not request sends; outside audience not allowed | 🟡 call F |
| `codex-worker` tries to send email itself | refused: send isn't in its slice | 🟡 |
| `household-agent` tries to run on your laptop | not allowed: it runs only on household units | ✅ D-15 |
| `codex-worker` posts a summary of your private email on the household board | needs your explicit OK; private-derived content stays private by default | 🟡 council point 4 |
| A presenter (IDE, Hermes page) claims "the owner approved" | refused: only an answer authenticated as your device or session counts | 🟡 §8.5 |
| A copied VM image tries to act as the household VM | must be refused | ❓ T-7 |

## J9. Revoking things

| You revoke | Stops | Keeps | Status |
|---|---|---|---|
| your lost iPhone | its answers from then on | your other devices | 🟡 |
| agent `codex-worker#01b` | all its credentials | its history for audit | 🟡 |
| persona `codex-worker` | every agent of that kind | history | 🟡 |
| the calendar share | future reads by household agents | what was already read | 🟡 |
| the household VM | its services and new agents from its launcher | history; running agents ❓ | 🟡 · ❓ |

How quickly each checkpoint sees a revocation is open (T-6).

## J10. A Host offline for five hours

1. Your laptop's Host holds a write lease and renews it every 15 minutes. ✅ D-5
2. The laptop sleeps. After the lease expires, the Host's lease-gated writes, wakes and schedules **pause**. Reads continue. There is no queueing of writes and no bypass. 🟡 (Router FL-9; ✅ D-5 sets the cadence and maximum)
3. When the laptop wakes and renews on the same epoch, the paused work resumes. If another installation took over meanwhile, this one doesn't.

**Outcome.** Nothing writes under a stale lease. Agents don't work offline anyway: "its fallacy to think they can work with llm if they are not lonline".

**Not built yet:** which AgentStudio capabilities are lease-gated (T-13).
