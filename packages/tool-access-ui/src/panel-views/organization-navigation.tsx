import { Badge } from '@tool-access-ui/components/ui/badge';
import {
	Sidebar,
	SidebarHeader,
	SidebarContent,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuButton,
	useSidebar,
} from '@tool-access-ui/components/ui/sidebar';
import { KeyRound, History, SlidersHorizontal } from 'lucide-react';
import { type ReactElement } from 'react';
export const destinations = [
	{ id: 'access', label: 'Access', icon: SlidersHorizontal },
	{ id: 'accounts', label: 'Accounts', icon: KeyRound },
	{ id: 'audit', label: 'Audit log', icon: History },
] as const;
export type Destination = (typeof destinations)[number]['id'];
export function OrganizationNavigation({
	destination,
	onSelect,
	organization,
	person,
	sourceLabel,
}: {
	readonly organization: string;
	readonly person: string;
	readonly sourceLabel: string;
	readonly destination: Destination;
	readonly onSelect: (destination: Destination) => void;
}): ReactElement {
	const { setOpenMobile } = useSidebar();
	return (
		<Sidebar collapsible="offcanvas">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg">
							<div className="grid">
								<span>{organization}</span>
								<span>{person}</span>
							</div>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
				<Badge variant="outline">{sourceLabel}</Badge>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu aria-label="Tool Portal navigation">
						{destinations.map(
							(item): ReactElement => (
								<SidebarMenuItem key={item.id}>
									<SidebarMenuButton
										isActive={destination === item.id}
										onClick={(): void => {
											onSelect(item.id);
											setOpenMobile(false);
										}}
									>
										<item.icon />
										<span>{item.label}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							),
						)}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}
