import { createToolAccessPanelFixture } from '@tool-access-ui/panel-demo/panel-fixture';
import { ToolAccessPanel } from '@tool-access-ui/tool-access-panel';
import { createRoot } from 'react-dom/client';
const root = document.getElementById('root');
if (!root) throw new Error('Panel root missing');
const port = createToolAccessPanelFixture();
createRoot(root).render(<ToolAccessPanel port={port} />);
