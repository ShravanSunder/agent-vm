import { useRef, useState, type ReactElement, type SubmitEvent } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
	Field,
	FieldLabel,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldSet,
	FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from '@/components/ui/select';
import {
	Sheet,
	SheetTrigger,
	SheetContent,
	SheetHeader,
	SheetTitle,
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
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

import { catalogTools, toolGroups, harnessNames, agentInputSchema } from './review-contracts';
import { FormNotice, type FormOutcome, type ReviewFormProps } from './review-forms';

export function AgentRegistration({ state, submitCommand }: ReviewFormProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [agentName, setAgentName] = useState('');
	const [harness, setHarness] = useState<(typeof harnessNames)[number]>('Codex');
	const [selectionMode, setSelectionMode] = useState('selected');
	const [toolIds, setToolIds] = useState<string[]>(
		['web-search', 'web-scrape'].filter((id): boolean => state.workspaceToolIds.includes(id)),
	);
	const [nameError, setNameError] = useState<string | undefined>();
	const [outcome, setOutcome] = useState<FormOutcome>({ kind: 'idle' });
	const nameInput = useRef<HTMLInputElement>(null);
	const eligibleTools =
		selectionMode === 'none'
			? []
			: toolIds.filter((id): boolean => state.workspaceToolIds.includes(id));
	async function registerAgent(event: SubmitEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const parsed = agentInputSchema.safeParse({ name: agentName, harness, toolIds: eligibleTools });
		if (!parsed.success) {
			setNameError(parsed.error.issues[0]?.message);
			nameInput.current?.focus();
			return;
		}
		setNameError(undefined);
		setOutcome({ kind: 'saving' });
		const result = await submitCommand({
			kind: 'register-agent',
			revision: state.revision,
			...parsed.data,
		});
		if (result.kind === 'saved') {
			toast.success(`${parsed.data.name} registered`);
			setOutcome({ kind: 'idle' });
			setOpen(false);
			setAgentName('');
		} else setOutcome(result);
	}
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<Card>
				<CardHeader>
					<CardTitle>Registered agents</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Harness</TableHead>
								<TableHead>Tools</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{state.agents.map((agent): ReactElement => (
								<TableRow key={agent.id}>
									<TableCell>{agent.name}</TableCell>
									<TableCell>
										<Badge variant="outline">{agent.harness}</Badge>
									</TableCell>
									<TableCell>
										<Tooltip>
											<TooltipTrigger render={<span tabIndex={0} />}>
												{agent.toolIds.length} {agent.toolIds.length === 1 ? 'tool' : 'tools'}
											</TooltipTrigger>
											<TooltipContent>
												{agent.toolIds
													.map(
														(id): string =>
															catalogTools.find((tool): boolean => tool.id === id)?.name ??
															'Unknown tool',
													)
													.join(', ') || 'No resource tools'}
											</TooltipContent>
										</Tooltip>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
				<CardFooter>
					<div className="ml-auto">
						<SheetTrigger render={<Button />}>Register agent</SheetTrigger>
					</div>
				</CardFooter>
			</Card>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>Register agent</SheetTitle>
				</SheetHeader>
				<form
					id="agent-registration"
					noValidate
					className="min-h-0 flex-1 overflow-y-auto px-6"
					onSubmit={(event): void => {
						void registerAgent(event);
					}}
				>
					<FieldGroup>
						<FormNotice outcome={outcome} />
						<Field data-invalid={!!nameError}>
							<FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
							<Input
								id="agent-name"
								ref={nameInput}
								value={agentName}

								maxLength={60}
								aria-invalid={!!nameError}
								aria-describedby={nameError ? 'agent-name-error' : undefined}
								onChange={(event): void => {
									setAgentName(event.target.value);
									if (nameError) setNameError(undefined);
								}}
							/>
							{nameError && <FieldError id="agent-name-error">{nameError}</FieldError>}
						</Field>
						<Field>
							<FieldLabel htmlFor="agent-harness">Harness</FieldLabel>
							<Select
								value={harness}
								items={harnessNames.map((name): { label: string; value: string } => ({
									label: name,
									value: name,
								}))}
								onValueChange={(value): void => {
									const parsed = agentInputSchema.shape.harness.safeParse(value);
									if (parsed.success) setHarness(parsed.data);
								}}
							>
								<SelectTrigger id="agent-harness" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{harnessNames.map((name): ReactElement => (
										<SelectItem key={name} value={name}>
											{name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<FieldSet>
							<FieldLegend>Tool access</FieldLegend>
							<RadioGroup
								value={selectionMode}
								onValueChange={setSelectionMode}
								aria-label="Resource tool selection"
							>
								<Field orientation="horizontal">
									<RadioGroupItem value="none" id="no-tools" />
									<FieldLabel htmlFor="no-tools">No resource tools</FieldLabel>
								</Field>
								<Field orientation="horizontal">
									<RadioGroupItem value="selected" id="choose-tools" />
									<FieldLabel htmlFor="choose-tools">Choose tools</FieldLabel>
								</Field>
							</RadioGroup>
						</FieldSet>
						{selectionMode === 'selected' &&
							toolGroups.map((group): ReactElement | null => {
								const tools = catalogTools.filter(
									(tool): boolean =>
										tool.group === group && state.workspaceToolIds.includes(tool.id),
								);
								return tools.length ? (
									<FieldSet key={group}>
										<FieldLegend>{group}</FieldLegend>
										<FieldGroup>
											{tools.map((tool): ReactElement => (
												<Field key={tool.id} orientation="horizontal">
													<Checkbox
														id={`agent-${tool.id}`}
														checked={eligibleTools.includes(tool.id)}
														disabled={outcome.kind === 'saving'}
														onCheckedChange={(checked): void => {
															setToolIds((previous): string[] =>
																checked
																	? [...previous, tool.id]
																	: previous.filter((id): boolean => id !== tool.id),
															);
														}}
													/>
													<FieldLabel htmlFor={`agent-${tool.id}`}>{tool.name}</FieldLabel>
												</Field>
											))}
										</FieldGroup>
									</FieldSet>
								) : null;
							})}
						{selectionMode === 'selected' && (
							<FieldDescription>
								{eligibleTools.length} {eligibleTools.length === 1 ? 'tool' : 'tools'} selected
							</FieldDescription>
						)}
					</FieldGroup>
				</form>
				<SheetFooter>
					<Button type="submit" form="agent-registration" disabled={outcome.kind === 'saving'}>
						{outcome.kind === 'saving' ? 'Registering…' : 'Register agent'}
					</Button>
					<SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
