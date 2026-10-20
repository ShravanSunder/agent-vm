import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';

import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
	AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import {
	Table,
	TableHeader,
	TableBody,
	TableRow,
	TableHead,
	TableCell,
} from '@/components/ui/table';

import { AccountStatusBadge } from './account-status-badge';
import { catalogTools, toolGroups } from './review-contracts';
import { FormNotice, type FormOutcome, type ReviewFormProps } from './review-forms';

function ToolBucketCard({
	group,
	state,
	submitCommand,
}: ReviewFormProps & { readonly group: (typeof toolGroups)[number] }): ReactElement {
	const bucketTools = catalogTools.filter((tool): boolean => tool.group === group);
	const [selectedTools, setSelectedTools] = useState(
		state.workspaceToolIds.filter((id): boolean =>
			bucketTools.some((tool): boolean => tool.id === id),
		),
	);
	const [outcome, setOutcome] = useState<FormOutcome>({ kind: 'idle' });
	const [confirmRemoval, setConfirmRemoval] = useState(false);
	const currentBucketIds = state.workspaceToolIds.filter((id): boolean =>
		bucketTools.some((tool): boolean => tool.id === id),
	);
	const changed =
		selectedTools.length !== currentBucketIds.length ||
		selectedTools.some((id): boolean => !currentBucketIds.includes(id));
	const removedTools = bucketTools.filter(
		(tool): boolean => currentBucketIds.includes(tool.id) && !selectedTools.includes(tool.id),
	);
	const affectedAgents = state.agents.filter((agent): boolean =>
		removedTools.some((tool): boolean => agent.toolIds.includes(tool.id)),
	);
	async function saveTools(): Promise<void> {
		setConfirmRemoval(false);
		setOutcome({ kind: 'saving' });
		const toolIds = [
			...state.workspaceToolIds.filter(
				(id): boolean => !bucketTools.some((tool): boolean => tool.id === id),
			),
			...selectedTools,
		];
		const result = await submitCommand({
			kind: 'workspace-tools',
			revision: state.revision,
			toolIds,
		});
		if (result.kind === 'saved') {
			toast.success('Tool access updated');
			setOutcome({ kind: 'idle' });
		} else setOutcome(result);
	}
	return (
		<Card role="region" aria-label={group}>
			<CardHeader>
				<CardTitle>{group}</CardTitle>
			</CardHeader>
			<CardContent>
				<FormNotice outcome={outcome} />
				<Table className="table-fixed min-w-3xl">
					<TableHeader>
						<TableRow>
							<TableHead className="w-1/3">Tool</TableHead>
							<TableHead className="w-1/4">Provider</TableHead>
							<TableHead className="w-1/6">Approval</TableHead>
							<TableHead className="w-1/6">Account</TableHead>
							<TableHead className="w-1/12">Allowed</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{bucketTools.map((tool): ReactElement => {
							const requiresAccount = tool.accountRequired;
							const requiresApproval = tool.approval === 'Approval required';
							return (
								<TableRow key={tool.id}>
									<TableCell>
										<FieldContent>
											<FieldLabel htmlFor={`workspace-${tool.id}`}>{tool.name}</FieldLabel>
											<FieldDescription>{tool.detail}</FieldDescription>
										</FieldContent>
									</TableCell>
									<TableCell>{tool.source}</TableCell>
									<TableCell>
										<Badge variant={requiresApproval ? 'outline' : 'secondary'}>
											{requiresApproval ? 'Approval required' : 'Not required'}
										</Badge>
									</TableCell>
									<TableCell>
										{requiresAccount ? <AccountStatusBadge account={state.account} /> : '—'}
									</TableCell>
									<TableCell>
										<Switch
											id={`workspace-${tool.id}`}
											aria-label={`Allow ${tool.name}`}
											checked={selectedTools.includes(tool.id)}
											disabled={outcome.kind === 'saving'}
											onCheckedChange={(checked): void => {
												setSelectedTools((previous): string[] =>
													checked
														? [...previous, tool.id]
														: previous.filter((id): boolean => id !== tool.id),
												);
												setOutcome({ kind: 'idle' });
											}}
										/>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</CardContent>
			<CardFooter>
				<div className="flex w-full flex-wrap items-center justify-between gap-3">
					<span>
						{selectedTools.length} of {bucketTools.length} allowed
					</span>
					<div className="flex gap-2">
						<Button
							variant="outline"
							disabled={!changed || outcome.kind === 'saving'}
							onClick={(): void => {
								setSelectedTools(currentBucketIds);
								setOutcome({ kind: 'idle' });
							}}
						>
							Discard
						</Button>
						<Button
							disabled={!changed || outcome.kind === 'saving'}
							onClick={(): void => {
								if (affectedAgents.length) setConfirmRemoval(true);
								else void saveTools();
							}}
						>
							{outcome.kind === 'saving' ? 'Saving…' : 'Save changes'}
						</Button>
					</div>
				</div>
			</CardFooter>
			<AlertDialog open={confirmRemoval} onOpenChange={setConfirmRemoval}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove tool access?</AlertDialogTitle>
						<AlertDialogDescription>
							{affectedAgents.map((agent): string => agent.name).join(' and ')} will lose{' '}
							{removedTools.map((tool): string => tool.name).join(', ')}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep access</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={(): void => {
								void saveTools();
							}}
						>
							Remove access
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
export function WorkspaceTools(props: ReviewFormProps): ReactElement {
	return (
		<section className="space-y-6">
			{toolGroups.map((group): ReactElement => (
				<ToolBucketCard key={group} group={group} {...props} />
			))}
		</section>
	);
}
