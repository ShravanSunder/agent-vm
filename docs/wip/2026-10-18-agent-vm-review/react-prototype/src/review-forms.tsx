import { CircleAlert } from 'lucide-react';
import type { ReactElement } from 'react';

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

import type { ReviewCommand, ReviewState } from './review-contracts';
export type FormOutcome =
	| { readonly kind: 'idle' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'saved'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string };
export interface ReviewFormProps {
	readonly state: ReviewState;
	readonly submitCommand: (command: ReviewCommand) => Promise<FormOutcome>;
}
export function FormNotice({ outcome }: { readonly outcome: FormOutcome }): ReactElement | null {
	return outcome.kind === 'error' ? (
		<Alert variant="destructive">
			<CircleAlert />
			<AlertTitle>Couldn’t save</AlertTitle>
			<AlertDescription>{outcome.message}</AlertDescription>
		</Alert>
	) : null;
}
