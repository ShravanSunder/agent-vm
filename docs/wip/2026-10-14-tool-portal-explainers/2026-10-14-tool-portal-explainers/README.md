# Tool Portal explainers

Four paired explainers cover the system, approval, harness access and the portable-runtime idea. Markdown carries the readable text and source links. HTML adds tabs, prepared SVG diagrams, theme switching, zoom and a native disclosure of the full Markdown source.

| Start here | Markdown | HTML |
| --- | --- | --- |
| The system today | [Two portals, one capability path](portal-system.md) | [Interactive view](portal-system.html) |
| Approval and recovery | [Approval, operations and reconnects](approval-and-reconnects.md) | [Interactive view](approval-and-reconnects.html) |
| Harnesses and discovery | [One policy, different tool presentations](harness-presentation.md) | [Interactive view](harness-presentation.html) |
| Portable service options | [A portable tool service for your machines](portable-runtime.md) | [Interactive view](portable-runtime.html) |

The HTML collection starts at [index.html](index.html). Each page is independently readable and links to the other explainers.

## Preview locally

From the Agent VM checkout root:

```sh
python3 -m http.server 0 --bind 127.0.0.1 --directory docs/wip/2026-10-14-tool-portal-explainers
```

Open the loopback URL and port printed by the server, then `index.html`. Serving over HTTP enables the ES-module reading controls. The prepared prose and SVGs remain readable without those controls. The bundle has local fonts, styles and runtime assets; source links deliberately navigate to their original locations.

## Reading boundaries

- Agent VM source snapshot: `8535fdd433dc90fed627ee7a05f63e59d58cf8ee`.
- Router design/source snapshot: `d0bb5c100aa00be9c8bc56bd9f23029e4ff5f38c`.
- Harness and protocol research snapshot: 2026-10-14, with release-specific limits in the text.
- Current source, proposed options and unverified behavior are named separately.
- Authority placement is an option to compare. No architecture recommendation is presented as owner-approved.
- This bundle makes no live tool calls, creates no VMs and records no approval decisions.

The original request also asked for code-mode discovery choices, socket-based local/remote access, logical-session resilience, Rust versus TypeScript and configuration-driven machine/VM access. The four explainers cover those branches rather than reducing the discussion to approval placement.

## Visual reference and provenance

The supplied [local HTML Islands reference](http://127.0.0.1:4173/experiments/html-islands-live.html) was inspected in Chrome. Its source is in the private local presentation-experiments lab. The collection reuses its Literata/IBM Plex typography, light/dark tokens, sticky contents rail and packaged island controls. The original lab was left unchanged.

[Asset notes](assets/README.md) identify the copied style/runtime and bundled license notices. The six SVG diagrams are authored for this conversation, with relationships and limits described in the adjacent prose.

The HTML view is derived from each Markdown source and embeds an exact copy in its source disclosure. This is a discussion bundle under `docs/wip`, not canonical architecture documentation, a deployment manual or an implementation plan.
