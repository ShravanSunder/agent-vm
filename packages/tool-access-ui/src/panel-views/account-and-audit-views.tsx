import { Badge } from '@tool-access-ui/components/ui/badge';
import { Button } from '@tool-access-ui/components/ui/button';
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
} from '@tool-access-ui/components/ui/card';
import {
	Empty,
	EmptyHeader,
	EmptyTitle,
	EmptyDescription,
} from '@tool-access-ui/components/ui/empty';
import {
	Table,
	TableHeader,
	TableHead,
	TableRow,
	TableBody,
	TableCell,
} from '@tool-access-ui/components/ui/table';
import type {
	PanelSnapshot,
	ConnectedAccount,
} from '@tool-access-ui/panel-state/models/panel-view-types';
import type { ReactElement } from 'react';
export function AccountsView({
	snapshot,
	onOpen,
}: {
	readonly snapshot: PanelSnapshot;
	readonly onOpen: (account: ConnectedAccount) => void;
}): ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Connected accounts</CardTitle>
				<CardDescription>
					Each person connects their own personal accounts for an agent. Protected connection and
					assignment editors are integration slots.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Table aria-label="Accounts">
					<TableHeader>
						<TableRow>
							<TableHead>Account</TableHead>
							<TableHead>Type / owner</TableHead>
							<TableHead>Provider</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Used by</TableHead>
							<TableHead>Details</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{snapshot.accounts.map(
							(account): ReactElement => (
								<TableRow key={account.name}>
									<TableCell>
										<div>{account.name}</div>
										<div>{account.address}</div>
									</TableCell>
									<TableCell>
										{account.kind} · {account.owner}
									</TableCell>
									<TableCell>{account.provider}</TableCell>
									<TableCell>
										<Badge variant={account.status === 'Connected' ? 'default' : 'outline'}>
											{account.status}
										</Badge>
									</TableCell>
									<TableCell>
										{[
											...new Set(
												snapshot.associations
													.filter((row): boolean => row.account === account.name)
													.flatMap((row): readonly string[] => row.agents),
											),
										].join(', ') || 'No assigned agents'}
									</TableCell>
									<TableCell>
										<Button variant="outline" onClick={(): void => onOpen(account)}>
											Open account
										</Button>
									</TableCell>
								</TableRow>
							),
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}
export function AuditView({ snapshot }: { readonly snapshot: PanelSnapshot }): ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Audit events</CardTitle>
				<CardDescription>{snapshot.sourceLabel}</CardDescription>
			</CardHeader>
			<CardContent>
				{snapshot.audit.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>No changes yet</EmptyTitle>
							<EmptyDescription>
								Confirmed changes appear here when supplied by the host.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table aria-label="Audit events">
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
							{snapshot.audit.map(
								(entry): ReactElement => (
									<TableRow key={entry.id}>
										<TableCell>{entry.when}</TableCell>
										<TableCell>{entry.who}</TableCell>
										<TableCell>{entry.change}</TableCell>
										<TableCell>{entry.target}</TableCell>
										<TableCell>{entry.details}</TableCell>
									</TableRow>
								),
							)}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
