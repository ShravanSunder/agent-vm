import { MoreHorizontal } from 'lucide-react';
import { useRef, useState, type ReactElement, type SubmitEvent } from 'react';
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
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel, FieldError, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemTitle, ItemDescription } from '@/components/ui/item';
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
	SheetFooter,
	SheetClose,
} from '@/components/ui/sheet';
import {
	Table,
	TableHeader,
	TableBody,
	TableRow,
	TableHead,
	TableCell,
} from '@/components/ui/table';

import { AccountStatusBadge } from './account-status-badge';
import { accountInputSchema } from './review-contracts';
import { FormNotice, type FormOutcome, type ReviewFormProps } from './review-forms';

export function AccountConfirmation({ state, submitCommand }: ReviewFormProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [alias, setAlias] = useState('Team calendar');
	const [aliasError, setAliasError] = useState<string | undefined>();
	const [outcome, setOutcome] = useState<FormOutcome>({ kind: 'idle' });
	const aliasInput = useRef<HTMLInputElement>(null);
	async function confirmAccount(event: SubmitEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const parsed = accountInputSchema.safeParse({ alias });
		if (!parsed.success) {
			setAliasError(parsed.error.issues[0]?.message);
			aliasInput.current?.focus();
			return;
		}
		setAliasError(undefined);
		setOutcome({ kind: 'saving' });
		const result = await submitCommand({
			kind: 'confirm-account',
			revision: state.revision,
			alias: parsed.data.alias,
		});
		if (result.kind === 'saved') {
			toast.success('Account connected');
			setOpen(false);
			setOutcome({ kind: 'idle' });
		} else setOutcome(result);
	}
	async function cancelConnection(): Promise<void> {
		setConfirmCancel(false);
		setAliasError(undefined);
		setOutcome({ kind: 'saving' });
		const result = await submitCommand({ kind: 'cancel-account', revision: state.revision });
		if (result.kind === 'saved') {
			toast.success('Connection cancelled');
			setOpen(false);
			setOutcome({ kind: 'idle' });
		} else setOutcome(result);
	}
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<Card>
				<CardHeader>
					<CardTitle>Google accounts</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Account</TableHead>
								<TableHead>Provider</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell>
									{state.account.kind === 'connected' ? state.account.alias : 'Team calendar'}
									<ItemDescription>team@example.test</ItemDescription>
								</TableCell>
								<TableCell>Google Workspace</TableCell>
								<TableCell>
									<AccountStatusBadge account={state.account} />
								</TableCell>
								<TableCell>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button variant="ghost" size="icon-sm" aria-label="Account actions" />
											}
										>
											<MoreHorizontal />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={(): void => {
													setOpen(true);
												}}
											>
												{state.account.kind === 'pending' ? 'Review connection' : 'View details'}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</TableCell>
							</TableRow>
						</TableBody>
					</Table>
				</CardContent>
			</Card>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>
						{state.account.kind === 'pending' ? 'Confirm account' : 'Account details'}
					</SheetTitle>
					<SheetDescription>team@example.test</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto px-6">
					<FieldGroup>
						<FormNotice outcome={outcome} />
						<Item>
							<ItemContent>
								<ItemTitle>Google granted</ItemTitle>
								<ItemDescription>Calendar events</ItemDescription>
								<ItemDescription>Selected Drive files</ItemDescription>
							</ItemContent>
						</Item>
						{state.account.kind === 'pending' ? (
							<Item>
								<ItemContent>
									<form
										id="account-confirmation"
										noValidate
										onSubmit={(event): void => {
											void confirmAccount(event);
										}}
									>
										<Field data-invalid={!!aliasError}>
											<FieldLabel htmlFor="account-alias">Account name</FieldLabel>
											<Input
												ref={aliasInput}
												id="account-alias"
												value={alias}
												maxLength={60}
												aria-invalid={!!aliasError}
												aria-describedby={aliasError ? 'account-alias-error' : undefined}
												onChange={(event): void => {
													setAlias(event.target.value);
													if (aliasError) setAliasError(undefined);
												}}
											/>
											{aliasError && <FieldError id="account-alias-error">{aliasError}</FieldError>}
										</Field>
									</form>
								</ItemContent>
							</Item>
						) : (
							<AccountStatusBadge account={state.account} />
						)}
					</FieldGroup>
				</div>
				<SheetFooter>
					{state.account.kind === 'pending' ? (
						<>
							<Button
								type="submit"
								form="account-confirmation"
								disabled={outcome.kind === 'saving'}
							>
								{outcome.kind === 'saving' ? 'Saving…' : 'Confirm account'}
							</Button>
							<Button
								variant="outline"
								disabled={outcome.kind === 'saving'}
								onClick={(): void => {
									setConfirmCancel(true);
								}}
							>
								Cancel connection
							</Button>
						</>
					) : (
						<SheetClose render={<Button variant="outline" />}>Close</SheetClose>
					)}
				</SheetFooter>
			</SheetContent>
			<AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Cancel this connection?</AlertDialogTitle>
						<AlertDialogDescription>
							team@example.test won’t be added to Studio.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep connection</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={(): void => {
								void cancelConnection();
							}}
						>
							Cancel connection
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Sheet>
	);
}
