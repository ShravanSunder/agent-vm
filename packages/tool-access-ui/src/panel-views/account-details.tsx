import { Alert, AlertTitle, AlertDescription } from '@tool-access-ui/components/ui/alert';
import { Badge } from '@tool-access-ui/components/ui/badge';
import { Button } from '@tool-access-ui/components/ui/button';
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
	CardFooter,
} from '@tool-access-ui/components/ui/card';
import {
	Field,
	FieldLabel,
	FieldDescription,
	FieldGroup,
} from '@tool-access-ui/components/ui/field';
import { Input } from '@tool-access-ui/components/ui/input';
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
} from '@tool-access-ui/components/ui/sheet';
import {
	Table,
	TableHeader,
	TableHead,
	TableRow,
	TableBody,
	TableCell,
} from '@tool-access-ui/components/ui/table';
import {
	type ConnectedAccount,
	type AccessRow,
} from '@tool-access-ui/panel-state/models/panel-view-types';
import { modeBadgeVariant } from '@tool-access-ui/panel-views/rule-display-labels';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
interface AccountDetailsProps {
	readonly account: ConnectedAccount;
	readonly proposalOpen: boolean;
	readonly rows: readonly AccessRow[];
	readonly onClose: () => void;
	readonly onPropose: (row: AccessRow) => void;
}
export function AccountDetails({
	account,
	proposalOpen,
	rows,
	onClose,
	onPropose,
}: AccountDetailsProps): ReactElement {
	const [name, setName] = useState(account.name);
	const [renaming, setRenaming] = useState(false);
	const [consentStep, setConsentStep] = useState(false);
	return (
		<Sheet
			open
			onOpenChange={(open): void => {
				if (!open) onClose();
			}}
		>
			<SheetContent side="right" className="overflow-y-auto">
				<SheetHeader>
					<SheetTitle>{account.name}</SheetTitle>
					<SheetDescription>{account.address}</SheetDescription>
				</SheetHeader>
				<div className="grid gap-4 p-4">
					{proposalOpen && (
						<Alert>
							<AlertTitle>A proposal is already open</AlertTitle>
							<AlertDescription>
								Close account details to accept or deny it before starting another.
							</AlertDescription>
						</Alert>
					)}
					<Card>
						<CardHeader>
							<CardTitle>Account details</CardTitle>
						</CardHeader>
						<CardContent>
							<FieldGroup>
								<Field>
									<FieldLabel>Type and owner</FieldLabel>
									<p>
										{account.kind} · {account.owner}
									</p>
									<FieldDescription>
										{account.kind === 'Personal'
											? `${account.owner} approves calls that need a person.`
											: 'Organization managers assign this account to agents.'}
									</FieldDescription>
								</Field>
								<Field>
									<FieldLabel>Provider granted</FieldLabel>
									<p>{account.grants}</p>
								</Field>
								<Field>
									<FieldLabel htmlFor="account-name">Account name</FieldLabel>
									<Input
										id="account-name"
										value={name}
										onChange={(event): void => {
											setName(event.target.value);
											setRenaming(true);
										}}
									/>
								</Field>
							</FieldGroup>
						</CardContent>
						<CardFooter className="justify-end">
							<Button
								disabled={!renaming || !name.trim()}
								onClick={(): void => {
									toast('Name draft ready. Account rename command is an open integration slot.');
								}}
							>
								Review name change
							</Button>
						</CardFooter>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>
								{account.kind === 'Integration' ? 'Required credentials' : 'Account rules'}
							</CardTitle>
						</CardHeader>
						<CardContent>
							{account.kind === 'Integration' ? (
								<FieldGroup>
									<Field>
										<FieldLabel>API key</FieldLabel>
										<p>No key supplied</p>
										<FieldDescription>
											The protected credential-entry contract is open. This mock does not collect
											secrets.
										</FieldDescription>
									</Field>
								</FieldGroup>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Action</TableHead>
											<TableHead>Mode</TableHead>
											<TableHead>Change</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows
											.filter((row): boolean => row.account === account.name)
											.map(
												(row): ReactElement => (
													<TableRow key={row.id}>
														<TableCell>{row.tool}</TableCell>
														<TableCell>
															<Badge variant={modeBadgeVariant(row.mode)}>{row.mode}</Badge>
														</TableCell>
														<TableCell>
															<Button
																variant="outline"
																disabled={proposalOpen}
																onClick={(): void => onPropose(row)}
															>
																Propose change
															</Button>
														</TableCell>
													</TableRow>
												),
											)}
									</TableBody>
								</Table>
							)}
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>
								{account.kind === 'Integration' ? 'Credential setup' : 'Provider connection'}
							</CardTitle>
						</CardHeader>
						<CardContent>
							<p>
								{account.kind === 'Integration'
									? 'Requires an API key from Firecrawl.'
									: 'Consent sets the provider grant. Account rules decide how the agent uses it.'}
							</p>
							{consentStep && (
								<Alert>
									<AlertTitle>Provider handoff</AlertTitle>
									<AlertDescription>
										{account.kind === 'Integration'
											? 'A protected key form will be supplied by the credential owner.'
											: 'Production opens the real Google OAuth screen and returns here for account confirmation. No simulated Google consent is shown.'}
									</AlertDescription>
								</Alert>
							)}
						</CardContent>
						<CardFooter className="justify-end">
							<Button onClick={(): void => setConsentStep(true)}>
								{account.kind === 'Integration' ? 'Review key setup' : 'Review sign-in steps'}
							</Button>
						</CardFooter>
					</Card>
				</div>
			</SheetContent>
		</Sheet>
	);
}
