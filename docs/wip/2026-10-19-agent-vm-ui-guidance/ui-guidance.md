# agent-vm control UI: design guidance

**For:** the 🦁 agent-vm Lead, who keeps authorship and integration. **From:** the 🦉 tool-portal Advisor, at the owner's request ("you need to guide the design … be specific … it doesnt have to be amazing but i dont want inconsistent slop").

**Evidence used:**
- the 12 screenshots in `docs/wip/2026-10-18-agent-vm-review/assets/react/`;
- the prototype source in `react-prototype/src`;
- the components installed in `/private/tmp/2026-10-agent-vm-react-workspace/src/components/ui`;
- `shadcn view` on the `base-mira` registry, which confirmed `alert-dialog`, `switch`, `item`, `sonner`, `toggle-group` and `radio-group` exist there.

**Not decided here:**
- authority semantics: who may grant what, and how a team account is told apart from a personal one;
- anything about the production backend.

Where a screen needs one of those, this guide says "leave a slot" rather than invent it.

## 1. The consistency rules

Inconsistency comes from making the same kind of thing look different on different screens. One rule per kind of thing:

| Kind of thing | Always use | Never |
|---|---|---|
| Page frame | `SidebarProvider` → `Sidebar` + `SidebarInset`. The page header is the `h1`, with page actions on the right. Add a `Breadcrumb` only below the top level (e.g. Agents › Calendar assistant) | a divider under every header; a breadcrumb that repeats the sidebar |
| A section | `Card`: `CardHeader` (`CardTitle`, optional `CardDescription`, `CardAction` for its buttons), `CardContent`, `CardFooter` for count + save | bare headings with hairline rules between sections |
| A list of records (tools, agents, accounts, audit events) | `Table` with `TableHead` column labels | hand-aligned text columns with no labels |
| A status word | `Badge`, with one fixed variant per meaning (table below) | plain grey text in a column; the same status in two styles |
| An on/off setting that takes effect on save | `Switch` in the row | `Checkbox` (a checkbox reads as "pick from a list", not "this setting is on"). Note: review finding UI2 is a different problem, the Google-consent Off state keeping its selections; Switches here don't fix it |
| Choosing several items inside a form | `Checkbox` fields in a `FieldSet` + `FieldLegend` + `FieldGroup` | raw `<fieldset>` / `<legend>` |
| One choice of two or three | `RadioGroup` | two checkboxes |
| Destructive or hard to undo | `AlertDialog` that names the exact consequence | a plain button; a generic warning sentence on the page |
| Creating or editing one record | `Sheet` (side="right") opened from a header button or a row | a form always open beside the list |
| Nothing to show yet | `Empty` (`EmptyMedia` icon, `EmptyTitle`, `EmptyDescription`, one action in `EmptyContent`) | an empty card or blank space |
| Field error | `FieldError` under the field | — |
| Request failed | `Alert variant="destructive"` at the top of the affected card, with a retry button | colored inline text |
| Success | `Sonner` toast | green inline text under the form |
| Buttons | one primary (`default`) per card, bottom right in `CardFooter`. Secondary is `outline`. Labels are verb + noun ("Save changes", "Register agent") | an arrow icon on Confirm; two filled buttons side by side |
| Icons | lucide, only inside buttons, menu items and `EmptyMedia` | decorative shields or info icons in body text |
| Styling | component defaults plus layout utilities (`gap-*`, grid/flex) | `review-layout.css`, hand-set text sizes or colors |
| Identifiers | human labels ("Read a web page"); machine ids only in a `Tooltip` or a detail view | `web-search, calendar-read` as the main value |

**Status vocabulary.** One word and one badge for each meaning, on every screen. Approval words are the tool modes the owner set (D-9):

| Meaning | Word | Badge |
|---|---|---|
| Tool runs without asking | Auto | `secondary` |
| Tool needs a person's approval per call | Approval required | `outline` |
| Tool is blocked | Blocked | `destructive` |
| A tool needs an account that isn't connected | Needs account | `outline` |
| Account connection not finished | Awaiting confirmation | `secondary` |
| Account connected | Connected | `default` |
| Tool not allowed in this workspace | (don't show it; see Agents) | — |

"Approved" from D-9 exists too. Its meaning in the UI (pre-approved for this agent?) is semantics, so leave a slot.

## 2. Screen by screen

### Shell and sidebar (every screen)

| Seen | Do instead |
|---|---|
| Sidebar footer: a shield icon and "Workspace availability / then agent selection / then resource policy." (the owner named this) | Delete it. The sidebar holds navigation only. |
| "Workspace / Studio / Demo workspace manager" stacked as three labels | `SidebarHeader` with one `SidebarMenuButton` (size="lg"): workspace name, with your role ("Manager") as the second line. It becomes the workspace switcher later (people join several workspaces, F-8) |
| Nav items | `SidebarGroup` › `SidebarMenu` › `SidebarMenuButton isActive`. Use `SidebarMenuBadge` for counts that need action, e.g. Accounts "1" while one awaits confirmation |
| Full-width banner "Interactive design preview · Example data · No live accounts, credentials or tool execution" | One `Badge variant="outline"`, "Demo data", in the sidebar header. The README already says the rest |
| Narrow width: nav becomes a wrapped row of pills (agents-narrow.jpg) | the Sidebar's built-in mobile `Sheet`, opened by `SidebarTrigger` in the page header |
| Breadcrumb "Studio › Agents" on top-level pages | Remove it at the top level. Use `Breadcrumb` only on detail pages |

### Workspace tools (workspace-tools.jpg)

| Seen | Do instead |
|---|---|
| Header text "Set the workspace's resource boundary. Give each agent the tools it needs." | No description, or "Tools that agents in Studio can be given." Agents are configured on another page, and "resource boundary" is architecture talk |
| A second header, "Available to Studio", plus a paragraph repeating the page header | Delete it |
| Unlabelled third column mixing four ideas: "Within configured limits", "Account access required", "Exact action approval", "Computer policy applies" | Split into labelled columns. **Approval** shows a Badge in the D-9 words. **Account** shows "Needs account" only when no account is connected. Delete "Within configured limits" and "Computer policy applies": they say nothing an operator can act on |
| Checkboxes for allowed | `Switch` in an **Allowed** column at the right edge |
| Save and Discard top right, far from the changes. Footer reads "5 of 7 tools selected" plus "Removing a tool narrows agent selections." | `CardFooter`: "5 of 7 allowed" on the left, `Discard` (outline) and `Save changes` on the right, enabled only when there are unsaved changes |
| The generic warning about narrowing | If saving would take a tool away from agents, open an `AlertDialog`: "Remove Read team documents? Research assistant and Calendar assistant will lose it." with Cancel / Remove |

Layout: one `Card` per bucket (the owner's buckets, F-24), each a `Table` with columns **Tool** (name plus a one-line description underneath), **Provider**, **Approval**, **Allowed**. Leave room for the fourth bucket; its name is open (Q-C11), so don't invent it.

```
┌ Useful cloud services ─────────────────────────────────────────────┐
│ Tool                     Provider        Approval        Allowed   │
│ Search the web           Search MCP      [Auto]            (●)     │
│   Public web results                                               │
│ Read a web page          Firecrawl MCP   [Auto]            (●)     │
├────────────────────────────────────────────────────────────────────┤
│ 2 of 2 allowed                          [Discard] [Save changes]   │
└────────────────────────────────────────────────────────────────────┘
```

### Agents (agent-registered.jpg, agent-validation.jpg)

| Seen | Do instead |
|---|---|
| A list on the left with an always-open "Register an agent" form on the right; the form dominates | A full-width `Table` of agents. Columns: **Name**, **Harness** (Badge `outline`), **Tools** (count, with the names in a `Tooltip`). The page header has a `Register agent` button that opens a `Sheet` with the form. Clicking a row opens the same `Sheet` in edit mode |
| Header and card text: "Named agents, independent of the client or machine they run on." / "An agent has its own tool selection, wherever its harness runs." / "Register the agent, then describe which harness it uses." | Delete all three. The last one also describes a step that doesn't exist |
| "A name your workspace can recognise." under the name field | Delete it, or state a real rule ("Must be unique in Studio") if the server enforces one |
| Tools the workspace doesn't allow, shown disabled with "Unavailable in this workspace" ×3 | Show only the tools the workspace allows: an agent's tools are a subset of the workspace's (F-24). Below the list, one muted line: "3 tools aren't allowed in Studio." with a link to Workspace tools |
| A flat checkbox list | Group by bucket: one `FieldSet` + `FieldLegend` per bucket, `Checkbox` fields inside a `FieldGroup` |
| Nothing for "communication only" | At the top of the tools section, a `RadioGroup`: **Messaging only** / **Choose tools**. The bucket groups show only for "Choose tools". This is F-23: managers configure the agent's tools, or only communication and collaboration tools |
| "Collaboration access is configured in its own service." floating under the list | Keep the fact, moved into the form: a `FieldDescription` under the tools legend: "Messaging tools come from agent-collaboration." |
| Green inline "Calendar assistant was added to Studio." | A `Sonner` toast, and close the Sheet |
| "Enter a name." validation | Keep it, as `FieldError` (it already is) |

```
Agents                                                  [+ Register agent]
┌────────────────────────────────────────────────────────────────────┐
│ Name                    Harness      Tools                         │
│ Research assistant      [Codex]      1                             │
│ Calendar assistant      [Hermes]     2                             │
└────────────────────────────────────────────────────────────────────┘
Sheet ▸ Register agent
  Name            [__________]
  Harness         [Hermes   ▾]
  Tools           (•) Messaging only   ( ) Choose tools
                  Messaging tools come from agent-collaboration.
                  ┌ Useful cloud services ┐  [x] Search the web …
  ────────────────────────────────────────────
                                  [Cancel] [Register agent]
```

### Accounts (account-confirmation.jpg, account-cancel.jpg)

| Seen | Do instead |
|---|---|
| Header "Connect team resources and keep provider consent separate from tool permission." | Delete it, or use "Accounts agents in Studio can use." |
| Shield callout: "A workspace manager chooses which agents can use a connected team account. Tool limits and required action approvals still apply." | Delete it |
| Account list as text rows | `Table`. Columns: **Account** (name, with the email underneath), **Provider**, **Status** (Badge), **Used by** (agent count). Each row gets a `DropdownMenu` with Rename and Disconnect; Disconnect opens an `AlertDialog` |
| Confirmation panel pinned beside the list | It's a step in the connect flow. Show it as a `Card` above the table only while an account awaits confirmation, or as a `Dialog` on return from the provider |
| "Provider consent received. Calendar events and selected Drive files. Provider scopes limit what the account can do; workspace tool settings decide what each agent may use." | Keep only the facts: "Google granted: Calendar events · Selected Drive files" as an `Item` list. Delete the second sentence |
| "Cancel connection" as a grey button next to "Confirm account →" | `Cancel` is `outline` and opens an `AlertDialog` ("Cancel connecting team@example.test? It won't be added to Studio."). `Confirm account` has no arrow |
| Team vs personal | Show a **Type** Badge column only once the classification is designed (F-35; open in the Lead's design). Leave the column slot; don't invent the rule in the fixture |
| No accounts | `Empty`: title "No accounts connected", one `Connect account` button |

### Audit log (audit-log.jpg)

| Seen | Do instead |
|---|---|
| Header text "Keep security-sensitive changes attributable and reviewable." and the card description "Who changed what, for which workspace, and the before and after values." | Delete both. The column headers say it |
| Yellow sentence "Review fixture: this is a demonstration log. Production ownership, durability and retention are still being designed." | Delete it; the "Demo data" badge covers it |
| Stacked blocks with Before / After labels and full lists | `Table`. Columns: **When**, **Who**, **Change**, **Target**, **Details** |
| Raw ids: "web-search, web-scrape, calendar-read…" | Human labels, showing only what changed: "Removed: Read a web page". For agent registration: "Tools: Search the web, Read team calendar" |
| Mixed casing: "pending" / "Cancelled" / "Not registered" | One vocabulary, as Badges from the status table |
| "9:09:01 PM" | "Oct 19, 9:09 PM", with the full timestamp in a `Tooltip` |
| Who = "Demo workspace manager" | Leave a slot for **Who** to show "agent, on behalf of person" when an agent made the change (F-30). How that's carried is open |

### Failures (agent-server-error.jpg, service-unavailable.jpg)

| Seen | Do instead |
|---|---|
| Request failure inside a form | `Alert variant="destructive"` at the top of the Sheet or Card. Keep the real message ("We could not confirm the result. Reload to check the current state before trying again.") plus a Retry button |
| Whole service unavailable | `Empty` in the page body: title "Tool Portal isn't responding", one Retry button. Don't keep a stale table on screen |
| Loading | `Skeleton` rows in the Table, not spinners in text |

## 3. Text: keep or cut

**Keep:** these are facts an operator acts on.
- Tool names, each with its one-line description.
- Provider names.
- The approval mode per tool, in the D-9 words.
- Counts ("5 of 7 allowed").
- Field validation messages.
- Real request-failure messages.
- Account email and status.
- What the provider granted.
- The audit log's when, who, change, target and what changed.
- "Messaging tools come from agent-collaboration."

**Cut:**
- the sidebar footer slogan and its shield;
- every page and card description that explains the architecture (listed in section 2);
- the "Available to Studio" header and paragraph;
- "Within configured limits" and "Computer policy applies";
- "Removing a tool narrows agent selections." (replaced by the specific AlertDialog);
- "A name your workspace can recognise." and "Register the agent, then describe which harness it uses.";
- the Accounts shield callout and the "Provider scopes limit…" sentence;
- the audit log's yellow fixture sentence;
- the full-width preview banner (replaced by the "Demo data" badge).

**Text rules:**
- Sentence case everywhere.
- Page titles are nouns, buttons are verb + noun.
- No description longer than one line, and none that doesn't change what the operator does next.

## 4. A check for the next screenshots

The next round passes when every one of these holds in the screenshots and the source:

1. Every visible container, list, control and status is a registry component, or has a stated reason not to be. No `div` with hand-written border or background classes.
2. Each card has exactly one primary button.
3. Each status word appears in one Badge variant only, across all screens.
4. No page or card description is longer than one line, and none appears in the "Cut" list above.
5. No CSS beyond the theme tokens; `review-layout.css` is gone.
6. At 1400 px and at phone width, the sidebar is the shadcn Sidebar: collapsed into its Sheet on phones, never a wrapped pill row.
7. Each destructive action opens an `AlertDialog` that names the consequence.

## Palette (owner direction, F-66)

Use `#1C2026` as the main app background. Reserve Bridge grey for editor and terminal surfaces only.
