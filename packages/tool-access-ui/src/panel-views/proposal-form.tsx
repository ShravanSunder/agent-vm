import { Alert, AlertDescription, AlertTitle } from '@tool-access-ui/components/ui/alert';
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
	AlertDialogAction,
} from '@tool-access-ui/components/ui/alert-dialog';
import { Badge } from '@tool-access-ui/components/ui/badge';
import { Button } from '@tool-access-ui/components/ui/button';
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	CardFooter,
} from '@tool-access-ui/components/ui/card';
import {
	Field,
	FieldLabel,
	FieldDescription,
	FieldError,
	FieldGroup,
} from '@tool-access-ui/components/ui/field';
import { Input } from '@tool-access-ui/components/ui/input';
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from '@tool-access-ui/components/ui/select';
import {
	approvalModes,
	type ProposalDraft,
} from '@tool-access-ui/panel-state/models/panel-view-types';
import {
	modeBadgeVariant,
	describeRuleScope,
} from '@tool-access-ui/panel-views/rule-display-labels';
import type { ReactElement } from 'react';
import { useState } from 'react';
export type ProposalActivity =
	| { readonly kind: 'editing' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'unconfirmed'; readonly message: string };
interface ProposalProps {
	readonly draft: ProposalDraft;
	readonly activity: ProposalActivity;
	readonly onEdit: (draft: ProposalDraft) => void;
	readonly onDeny: () => void;
	readonly onAccept: () => void;
	readonly onReadCurrent: () => void;
}
export function ProposalForm({
	draft,
	activity,
	onEdit,
	onDeny,
	onAccept,
	onReadCurrent,
}: ProposalProps): ReactElement {
	const [error, setError] = useState('');
	const [confirmBlock, setConfirmBlock] = useState(false);
	const row = draft.current;
	const busy = activity.kind === 'saving';
	const unresolved = activity.kind === 'unconfirmed';
	return (
		<Card aria-label="Proposal editor">
			<CardHeader>
				<CardTitle>Review proposed change</CardTitle>
				<CardDescription>Nothing changes until the host confirms acceptance.</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					id="proposal-form"
					onSubmit={(event): void => {
						event.preventDefault();
						if (busy || unresolved || draft.mode === 'auto' || draft.mode === row.mode) return;
						if (!draft.reason.trim()) {
							setError('Describe the change.');
							return;
						}
						if (draft.mode === 'blocked') {
							setConfirmBlock(true);
							return;
						}
						onAccept();
					}}
				>
					<FieldGroup>
						{(activity.kind === 'failed' || activity.kind === 'unconfirmed') && (
							<Alert variant="destructive">
								<AlertTitle>
									{unresolved ? 'Outcome not confirmed' : 'Change was not saved'}
								</AlertTitle>
								<AlertDescription>{activity.message} Your draft is retained.</AlertDescription>
								{unresolved && (
									<Button type="button" variant="outline" onClick={onReadCurrent}>
										Read current state
									</Button>
								)}
							</Alert>
						)}
						<Field>
							<FieldLabel>Tool and scope</FieldLabel>
							<p>
								{row.tool} · {describeRuleScope(row)}
							</p>
							<FieldDescription>
								Affects {row.agents.join(' and ')}. Authorized decision maker: {row.manager}.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel>Current mode</FieldLabel>
							<div>
								<Badge variant={modeBadgeVariant(row.mode)}>{row.mode}</Badge>
							</div>
						</Field>
						<Field>
							<FieldLabel htmlFor="proposed-mode">Proposed mode</FieldLabel>
							<Select
								value={draft.mode}
								disabled={busy || unresolved}
								onValueChange={(value): void => {
									const mode = approvalModes.find((item): boolean => item === value);
									if (mode) onEdit({ ...draft, mode });
								}}
							>
								<SelectTrigger id="proposed-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{approvalModes.map(
										(mode): ReactElement => (
											<SelectItem key={mode} value={mode}>
												{mode}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</Field>
						{draft.mode === 'auto' && (
							<Alert>
								<AlertTitle>Auto configuration slot</AlertTitle>
								<AlertDescription>
									Judge, fixed limits, eligible tools and escalation contracts are open. Auto cannot
									be activated here.
								</AlertDescription>
							</Alert>
						)}
						{draft.mode === 'approved' && (
							<Field>
								<FieldLabel htmlFor="approved-until">Approved until · future slot</FieldLabel>
								<Input
									id="approved-until"
									disabled
									placeholder="Unavailable in the first version"
								/>
								<FieldDescription>
									Future composition: time zone and previous mode; expiry returns to that mode.
								</FieldDescription>
							</Field>
						)}
						<Field data-invalid={Boolean(error)}>
							<FieldLabel htmlFor="proposal-reason">Change note</FieldLabel>
							<Input
								id="proposal-reason"
								value={draft.reason}
								disabled={busy || unresolved}
								aria-invalid={Boolean(error)}
								onChange={(event): void => {
									onEdit({ ...draft, reason: event.target.value });
									setError('');
								}}
							/>
							{error && <FieldError>{error}</FieldError>}
						</Field>
					</FieldGroup>
				</form>
			</CardContent>
			<CardFooter className="justify-end">
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" disabled={busy || unresolved} onClick={onDeny}>
						Deny proposal
					</Button>
					<Button
						type="submit"
						form="proposal-form"
						disabled={busy || unresolved || draft.mode === 'auto' || draft.mode === row.mode}
					>
						{busy ? 'Waiting for host…' : 'Accept change'}
					</Button>
				</div>
			</CardFooter>
			<AlertDialog open={confirmBlock} onOpenChange={setConfirmBlock}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Block {row.tool}?</AlertDialogTitle>
						<AlertDialogDescription>
							{row.agents.join(' and ')} will lose this action in {describeRuleScope(row)}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep editing</AlertDialogCancel>
						<AlertDialogAction
							onClick={(): void => {
								setConfirmBlock(false);
								onAccept();
							}}
						>
							Block tool
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
