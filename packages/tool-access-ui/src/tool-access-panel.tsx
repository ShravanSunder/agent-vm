import { Alert, AlertTitle, AlertDescription } from '@tool-access-ui/components/ui/alert';
import { Button } from '@tool-access-ui/components/ui/button';
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	CardFooter,
} from '@tool-access-ui/components/ui/card';
import { Field, FieldLabel } from '@tool-access-ui/components/ui/field';
import { Input } from '@tool-access-ui/components/ui/input';
import {
	SidebarProvider,
	SidebarInset,
	SidebarTrigger,
} from '@tool-access-ui/components/ui/sidebar';
import { Skeleton } from '@tool-access-ui/components/ui/skeleton';
import { Toaster } from '@tool-access-ui/components/ui/sonner';
import {
	Table,
	TableHeader,
	TableHead,
	TableRow,
	TableBody,
	TableCell,
} from '@tool-access-ui/components/ui/table';
import { TooltipProvider } from '@tool-access-ui/components/ui/tooltip';
import type {
	ToolAccessPanelPort,
	ConnectedAccount,
	AccessRow,
} from '@tool-access-ui/panel-state/models/panel-view-types';
import { usePanelModel } from '@tool-access-ui/panel-state/use-panel-model';
import { AccessAssociations } from '@tool-access-ui/panel-views/access-associations';
import { AccountsView, AuditView } from '@tool-access-ui/panel-views/account-and-audit-views';
import { AccountDetails } from '@tool-access-ui/panel-views/account-details';
import {
	OrganizationNavigation,
	destinations,
} from '@tool-access-ui/panel-views/organization-navigation';
import { ProposalForm } from '@tool-access-ui/panel-views/proposal-form';
import { Search } from 'lucide-react';
import { useState, type ReactElement } from 'react';
export interface ToolAccessPanelProps {
	readonly port: ToolAccessPanelPort;
}
/** Mount with one stable host port. The panel owns draft edits and view selection only. */
export function ToolAccessPanel({ port }: ToolAccessPanelProps): ReactElement {
	const model = usePanelModel(port);
	const [request, setRequest] = useState('');
	const [account, setAccount] = useState<ConnectedAccount | null>(null);
	const snapshot = model.load.kind === 'ready' ? model.load.snapshot : null;
	return (
		<TooltipProvider>
			<SidebarProvider>
				<OrganizationNavigation
					destination={model.destination}
					onSelect={model.setDestination}
					organization={snapshot?.organization ?? 'Organization'}
					person={snapshot?.person ?? 'Loading person…'}
					sourceLabel={snapshot?.sourceLabel ?? 'Loading host view…'}
				/>
				<SidebarInset>
					<header className="flex h-14 items-center gap-3 px-4">
						<SidebarTrigger />
						<h1>{destinations.find((item): boolean => item.id === model.destination)?.label}</h1>
					</header>
					<main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
						<Card>
							<CardHeader>
								<CardTitle>What would you like to see or change?</CardTitle>
								<CardDescription>
									Deterministic example routing. No model or credential is used.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<form
									id="request-form"
									onSubmit={(event): void => {
										event.preventDefault();
										model.submitRequest(request);
									}}
								>
									<Field>
										<FieldLabel htmlFor="request-bar">Request</FieldLabel>
										<Input
											id="request-bar"
											value={request}
											onChange={(event): void => setRequest(event.target.value)}
											placeholder="Show Maya’s email access, or block send email"
										/>
									</Field>
								</form>
								<div className="flex flex-wrap gap-2 pt-3">
									<Button variant="outline" onClick={(): void => setRequest('Show email access')}>
										Show email access
									</Button>
									<Button variant="outline" onClick={(): void => setRequest('Block send email')}>
										Block send email
									</Button>
									<Button
										variant="outline"
										onClick={(): void => {
											void model.showScan();
										}}
									>
										Show scan
									</Button>
								</div>
								<p role="status" aria-live="polite">
									{model.feedback}
								</p>
							</CardContent>
							<CardFooter className="justify-end">
								<Button
									type="submit"
									form="request-form"
									disabled={!snapshot || model.proposal.kind === 'preparing'}
								>
									<Search />
									Submit request
								</Button>
							</CardFooter>
						</Card>
						{model.proposal.kind === 'failed' && (
							<Alert variant="destructive">
								<AlertTitle>Request failed</AlertTitle>
								<AlertDescription>
									{model.proposal.message} No proposal was accepted.
								</AlertDescription>
								<Button variant="outline" onClick={model.retryProposal}>
									Retry request
								</Button>
							</Alert>
						)}
						{model.proposal.kind === 'preparing' && (
							<Skeleton aria-label="Preparing proposal" className="h-20" />
						)}
						{model.proposal.kind === 'open' && (
							<ProposalForm
								draft={model.proposal.draft}
								activity={model.proposal.activity}
								onEdit={model.editProposal}
								onDeny={(): void => {
									void model.denyProposal();
								}}
								onAccept={(): void => {
									void model.acceptProposal();
								}}
								onReadCurrent={(): void => {
									void model.readCurrent();
								}}
							/>
						)}
						{model.load.kind === 'loading' && (
							<Skeleton aria-label="Loading host view" className="h-20" />
						)}
						{model.load.kind === 'failed' && (
							<Alert variant="destructive">
								<AlertTitle>View unavailable</AlertTitle>
								<AlertDescription>{model.load.message}</AlertDescription>
								<Button variant="outline" onClick={model.retryRead}>
									Retry
								</Button>
							</Alert>
						)}
						{snapshot && model.destination === 'access' && (
							<>
								{model.scan.kind === 'loading' && (
									<Skeleton aria-label="Scanning integrations" className="h-20" />
								)}
								{model.scan.kind === 'failed' && (
									<Alert variant="destructive">
										<AlertTitle>Scan failed</AlertTitle>
										<AlertDescription>{model.scan.message}</AlertDescription>
										<Button
											variant="outline"
											onClick={(): void => {
												void model.showScan();
											}}
										>
											Retry scan
										</Button>
									</Alert>
								)}
								{model.scan.kind === 'ready' && (
									<Card>
										<CardHeader>
											<CardTitle>Built-in scan</CardTitle>
											<CardDescription>
												{model.scan.result.kind} checks · {model.scan.result.checkedAt}. A scan
												changes no access.
											</CardDescription>
										</CardHeader>
										<CardContent>
											<Table aria-label="Scan results">
												<TableHeader>
													<TableRow>
														<TableHead>Integration</TableHead>
														<TableHead>Status</TableHead>
														<TableHead>Next step</TableHead>
													</TableRow>
												</TableHeader>
												<TableBody>
													{model.scan.result.entries.map(
														(entry): ReactElement => (
															<TableRow key={entry.integration}>
																<TableCell>{entry.integration}</TableCell>
																<TableCell>{entry.status}</TableCell>
																<TableCell>{entry.nextStep}</TableCell>
															</TableRow>
														),
													)}
												</TableBody>
											</Table>
										</CardContent>
									</Card>
								)}
								<AccessAssociations
									snapshot={snapshot}
									filters={model.filters}
									onFilter={model.setFilters}
									proposalOpen={
										model.proposal.kind === 'open' || model.proposal.kind === 'preparing'
									}
									onPropose={model.proposeRow}
								/>
								<Card>
									<CardHeader>
										<CardTitle>Configuration integration slots</CardTitle>
										<CardDescription>
											Complete profile tools, applications, ceilings, limits and consent
											recommendations; agent registration and profile assignment; provider transport
											and egress; organization members and managers; exact-call approval adapters;
											Fleet and Tool VM. Host field and command contracts are pending. Workspaces
											are a later layer inside the organization.
										</CardDescription>
									</CardHeader>
								</Card>
							</>
						)}
						{snapshot && model.destination === 'accounts' && (
							<AccountsView snapshot={snapshot} onOpen={setAccount} />
						)}
						{snapshot && model.destination === 'audit' && <AuditView snapshot={snapshot} />}
					</main>
				</SidebarInset>
			</SidebarProvider>
			{account && snapshot && (
				<AccountDetails
					key={account.name}
					account={account}
					proposalOpen={model.proposal.kind === 'open' || model.proposal.kind === 'preparing'}
					rows={snapshot.associations}
					onClose={(): void => setAccount(null)}
					onPropose={(row: AccessRow): void => {
						if (model.proposal.kind === 'none' || model.proposal.kind === 'failed') {
							setAccount(null);
							model.proposeRow(row);
						}
					}}
				/>
			)}
			<Toaster theme="dark" />
		</TooltipProvider>
	);
}
