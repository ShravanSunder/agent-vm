import { Boxes, Wrench, UsersRound, KeyRound, History } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
	Sidebar,
	SidebarProvider,
	SidebarHeader,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuButton,
	SidebarInset,
	SidebarTrigger,
	useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AccountConfirmation } from './accounts-view';
import { AgentRegistration } from './agent-registration';
import { AuditLog } from './audit-event-table';
import {
	reviewStateSchema,
	responseSchema,
	type ReviewState,
	type ReviewCommand,
} from './review-contracts';
import { type FormOutcome } from './review-forms';
import { WorkspaceTools } from './workspace-tool-table';

const sections = [
	{ id: 'tools', label: 'Tools', icon: Wrench },
	{ id: 'agents', label: 'Agents', icon: UsersRound },
	{ id: 'accounts', label: 'Accounts', icon: KeyRound },
	{ id: 'audit', label: 'Audit log', icon: History },
] as const;
type ReviewSection = (typeof sections)[number]['id'];
function WorkspaceNavigation({
	section,
	onSelect,
}: {
	readonly section: ReviewSection;
	readonly onSelect: (section: ReviewSection) => void;
}): ReactElement {
	const { setOpenMobile } = useSidebar();
	return (
		<Sidebar collapsible="offcanvas">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							render={<a href="#tools" />}
							onClick={(): void => {
								onSelect('tools');
								setOpenMobile(false);
							}}
						>
							<Boxes />
							<div className="grid">
								<span className="font-medium">Studio</span>
								<span className="text-xs text-muted-foreground">Manager</span>
							</div>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Workspace</SidebarGroupLabel>
					<SidebarMenu aria-label="Workspace settings">
						{sections.map((item): ReactElement => (
							<SidebarMenuItem key={item.id}>
								<SidebarMenuButton
									isActive={section === item.id}
									aria-current={section === item.id ? 'page' : undefined}
									render={<a href={`#${item.id}`} />}
									onClick={(): void => {
										onSelect(item.id);
										setOpenMobile(false);
									}}
								>
									<item.icon />
									<span>{item.label}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}
function ReviewApplication(): ReactElement {
	const [section, setSection] = useState<ReviewSection>(
		(): ReviewSection =>
			sections.find((item): boolean => `#${item.id}` === location.hash)?.id ?? 'tools',
	);
	useEffect((): (() => void) => {
		const syncSection = (): void => {
			setSection(sections.find((item): boolean => `#${item.id}` === location.hash)?.id ?? 'tools');
		};
		window.addEventListener('hashchange', syncSection);
		return (): void => {
			window.removeEventListener('hashchange', syncSection);
		};
	}, []);
	const [loaded, setLoaded] = useState<
		{ kind: 'loading' } | { kind: 'ready'; state: ReviewState } | { kind: 'failed' }
	>({ kind: 'loading' });
	useEffect((): void => {
		fetch('/api/review')
			.then(async (response): Promise<void> => {
				const state = reviewStateSchema.parse(await response.json());
				setLoaded({ kind: 'ready', state });
			})
			.catch((): void => {
				setLoaded({ kind: 'failed' });
			});
	}, []);
	async function submitCommand(command: ReviewCommand): Promise<FormOutcome> {
		try {
			const response = await fetch('/api/review', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-review-scenario': new URLSearchParams(location.search).get('scenario') ?? 'normal',
				},
				body: JSON.stringify(command),
			});
			const result = responseSchema.parse(await response.json());
			if (result.kind === 'rejected') return { kind: 'error', message: result.message };
			setLoaded({ kind: 'ready', state: result.state });
			return { kind: 'saved', message: 'Saved.' };
		} catch {
			return {
				kind: 'error',
				message: 'The result could not be confirmed. Reload to check before trying again.',
			};
		}
	}
	return (
		<TooltipProvider>
			<SidebarProvider>
				<WorkspaceNavigation section={section} onSelect={setSection} />
				<SidebarInset>
					<header className="flex h-14 items-center gap-3 px-4">
						<SidebarTrigger />
						<h1 className="text-xl font-semibold">
							{sections.find((item): boolean => item.id === section)?.label}
						</h1>
						<div className="ml-auto">
							<Badge variant="outline">Demo data</Badge>
						</div>
					</header>
					<div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
						{loaded.kind === 'loading' && (
							<div role="status" aria-label="Loading workspace">
								<Skeleton className="h-48 w-full" />
							</div>
						)}
						{loaded.kind === 'failed' && (
							<Alert variant="destructive">
								<AlertTitle>Couldn’t load Studio</AlertTitle>
								<AlertDescription>Reload to try again.</AlertDescription>
							</Alert>
						)}
						{loaded.kind === 'ready' &&
							(section === 'tools' ? (
								<WorkspaceTools state={loaded.state} submitCommand={submitCommand} />
							) : section === 'agents' ? (
								<AgentRegistration state={loaded.state} submitCommand={submitCommand} />
							) : section === 'accounts' ? (
								<AccountConfirmation state={loaded.state} submitCommand={submitCommand} />
							) : (
								<AuditLog state={loaded.state} />
							))}
					</div>
				</SidebarInset>
			</SidebarProvider>
			<Toaster theme="dark" />
		</TooltipProvider>
	);
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Review root is missing');
createRoot(rootElement).render(<ReviewApplication />);
