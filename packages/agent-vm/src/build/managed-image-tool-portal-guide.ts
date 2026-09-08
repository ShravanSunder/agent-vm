export const managedToolPortalGuideFileName = 'agent-vm-tool-portal.md';
export const managedToolVmLoginProfileFileName = 'agent-vm-tool-vm-login-profile.sh';

export const managedToolVmLoginProfile = 'export PATH=/opt/agent-vm-tools/bin:/pnpm:$PATH\n';

export const managedToolPortalGuide = `# Tool Portal from Tool VM code

Your Python, TypeScript, or CLI composition runs in this Tool VM. Tool Portal
routes every discovery and call using the current invocation's authority. The
connection is created for each invocation and is not a persistent endpoint.

Discover before calling. Inspect each canonical item result, including its
execution certainty and artifact references, before deciding what to do next.
Calls that require approval wait for the originating human approval route.
Never automatically replay a call after a transport failure or uncertain effect.

Python (the client is an async context manager):

\`\`\`python
import asyncio
from agent_vm_agent_portal_sdk import connect_tool_portal

async def main():
    async with connect_tool_portal() as portal:
        found = await portal.search({
            "requests": [{"id": "find-1", "query": "status", "limit": 10}],
        })
        print(found.model_dump(mode="json", by_alias=True))
        # Replace example/status and arguments using the live discovery/schema.
        described = await portal.describe({
            "requests": [{
                "id": "describe-1",
                "tools": [{"namespace": "example", "name": "status"}],
            }],
        })
        result = await portal.call({
            "calls": [{
                "id": "call-1",
                "namespace": "example",
                "name": "status",
                "arguments": {},
            }],
        })
        print(result.model_dump(mode="json", by_alias=True))

asyncio.run(main())
\`\`\`

TypeScript (the factory is awaited):

\`\`\`typescript
import { connectToolPortal } from '@agent-vm/agent-portal-sdk';

const portal = await connectToolPortal();
try {
  const found = await portal.search({
    requests: [{ id: 'find-1', query: 'status', limit: 10 }],
  });
  const described = await portal.describe({
    requests: [{
      id: 'describe-1',
      tools: [{ namespace: 'example', name: 'status' }],
    }],
  });
  const result = await portal.call({
    calls: [{ id: 'call-1', namespace: 'example', name: 'status', arguments: {} }],
  });
} finally {
  await portal.close();
}
\`\`\`

CLI (managed transport is automatic; omit transport flags):

\`\`\`sh
tool-portal search --input-json '{"requests":[{"id":"find-1","query":"status","limit":10}]}'
tool-portal describe --input-json '{"requests":[{"id":"describe-1","tools":[{"namespace":"example","name":"status"}]}]}'
tool-portal call --input-json '{"calls":[{"id":"call-1","namespace":"example","name":"status","arguments":{}}]}'
\`\`\`

The \`example/status\` name is illustrative. Use discovery results from the live
Portal instead of assuming a provider or capability exists. Tool Portal chooses
the configured destination; do not add provider wrappers or select an execution
host in caller code.
`;
