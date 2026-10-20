import type { ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';

import type { ReviewState } from './review-contracts';
export function AccountStatusBadge({
	account,
}: {
	readonly account: ReviewState['account'];
}): ReactElement {
	switch (account.kind) {
		case 'pending':
			return <Badge variant="secondary">Awaiting confirmation</Badge>;
		case 'connected':
			return <Badge variant="default">Connected</Badge>;
		case 'cancelled':
			return <Badge variant="outline">Cancelled</Badge>;
	}
}
