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
	Empty,
	EmptyHeader,
	EmptyTitle,
	EmptyDescription,
	EmptyContent,
} from '@tool-access-ui/components/ui/empty';
import { Field, FieldLabel } from '@tool-access-ui/components/ui/field';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@tool-access-ui/components/ui/select';
import {
	Table,
	TableHeader,
	TableHead,
	TableRow,
	TableBody,
	TableCell,
} from '@tool-access-ui/components/ui/table';
import {
	allAccessFilters,
	modeBadgeVariant,
	type PanelSnapshot,
	type AccessFilters,
	type AccessRow,
} from '@tool-access-ui/panel-view-types';
import type { ReactElement } from 'react';
interface AccessProps {
	readonly snapshot: PanelSnapshot;
	readonly filters: AccessFilters;
	readonly proposalOpen: boolean;
	readonly onFilter: (filters: AccessFilters) => void;
	readonly onPropose: (row: AccessRow) => void;
}
interface FilterProps {
	readonly label: string;
	readonly value: string;
	readonly options: readonly string[];
	readonly onChange: (value: string) => void;
}
function FilterSelect({ label, value, options, onChange }: FilterProps): ReactElement {
	const id = `filter-${label.toLowerCase()}`;
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				value={value}
				onValueChange={(next): void => {
					if (typeof next === 'string') onChange(next);
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{['All', ...new Set(options)].map(
						(option): ReactElement => (
							<SelectItem key={option} value={option}>
								{option}
							</SelectItem>
						),
					)}
				</SelectContent>
			</Select>
		</Field>
	);
}
export function AccessAssociations({
	snapshot,
	filters,
	proposalOpen,
	onFilter,
	onPropose,
}: AccessProps): ReactElement {
	const rows = snapshot.associations;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Access in {snapshot.organization}</CardTitle>
				<CardDescription>
					Organization scope. Profiles set access; agent filters change only this view.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<FilterSelect
						label="Tool"
						value={filters.tool}
						options={rows.map((row): string => row.tool)}
						onChange={(tool): void => onFilter({ ...filters, tool })}
					/>
					<FilterSelect
						label="Agent"
						value={filters.agent}
						options={rows.flatMap((row): readonly string[] => row.agents)}
						onChange={(agent): void => onFilter({ ...filters, agent })}
					/>
					<FilterSelect
						label="Account"
						value={filters.account}
						options={rows.map((row): string => row.account)}
						onChange={(account): void => onFilter({ ...filters, account })}
					/>
					<FilterSelect
						label="Profile"
						value={filters.profile}
						options={rows.map((row): string => row.profile)}
						onChange={(profile): void => onFilter({ ...filters, profile })}
					/>
				</div>
				{snapshot.visibleAssociations.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>No matching access</EmptyTitle>
							<EmptyDescription>Clear a filter to see more tools.</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={(): void => onFilter(allAccessFilters)}>Clear filters</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Table aria-label="Access associations">
						<TableHeader>
							<TableRow>
								<TableHead>Tool</TableHead>
								<TableHead>Profile / agents</TableHead>
								<TableHead>Account</TableHead>
								<TableHead>Mode</TableHead>
								<TableHead>Change</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{snapshot.visibleAssociations.map(
								(row): ReactElement => (
									<TableRow key={row.id}>
										<TableCell>
											<div>{row.tool}</div>
											<div>
												{row.provider} · {row.toolKind}
											</div>
										</TableCell>
										<TableCell>
											<div>{row.profile}</div>
											<div>{row.agents.join(', ')}</div>
										</TableCell>
										<TableCell>{row.account}</TableCell>
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
			<CardFooter>
				{snapshot.visibleAssociations.length} of {rows.length} tool rules · Profile-only policy;
				per-agent tweaks are a future slot
			</CardFooter>
		</Card>
	);
}
