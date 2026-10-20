import { History } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
	Table,
	TableHeader,
	TableBody,
	TableRow,
	TableHead,
	TableCell,
} from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

import { catalogTools, type ReviewState } from './review-contracts';
function displayToolNames(value: string): string {
	return value
		.split(', ')
		.map((id): string => catalogTools.find((tool): boolean => tool.id === id)?.name ?? id)
		.join(', ');
}
function describeChange(event: ReviewState['auditEvents'][number]): string {
	if (event.action === 'Workspace tools changed') {
		const before = event.before ? event.before.split(', ') : [];
		const after = event.after ? event.after.split(', ') : [];
		const removed = before.filter((id): boolean => !after.includes(id));
		const added = after.filter((id): boolean => !before.includes(id));
		return [
			removed.length ? `Removed: ${displayToolNames(removed.join(', '))}` : '',
			added.length ? `Added: ${displayToolNames(added.join(', '))}` : '',
		]
			.filter(Boolean)
			.join(' · ');
	}
	if (event.action === 'Agent registered')
		return event.after === 'No resource tools'
			? 'No resource tools'
			: `Tools: ${displayToolNames(event.after)}`;
	return '—';
}
export function AuditLog({ state }: { readonly state: ReviewState }): ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Changes</CardTitle>
			</CardHeader>
			<CardContent>
				{state.auditEvents.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<History />
							</EmptyMedia>
							<EmptyTitle>No changes yet</EmptyTitle>
						</EmptyHeader>
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>When</TableHead>
								<TableHead>Who</TableHead>
								<TableHead>Change</TableHead>
								<TableHead>Target</TableHead>
								<TableHead>Details</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{state.auditEvents.map((event): ReactElement => (
								<TableRow key={event.id}>
									<TableCell>
										<Tooltip>
											<TooltipTrigger render={<span tabIndex={0} />}>
												<time dateTime={event.time}>
													{new Date(event.time).toLocaleString(undefined, {
														month: 'short',
														day: 'numeric',
														hour: 'numeric',
														minute: '2-digit',
													})}
												</time>
											</TooltipTrigger>
											<TooltipContent>{event.time}</TooltipContent>
										</Tooltip>
									</TableCell>
									<TableCell>{event.actor}</TableCell>
									<TableCell>{event.action}</TableCell>
									<TableCell>{event.subject}</TableCell>
									<TableCell>{describeChange(event)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
