import {
	CircleCheckIcon,
	InfoIcon,
	TriangleAlertIcon,
	OctagonXIcon,
	Loader2Icon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps): React.ReactElement => {
	const { theme = 'system' } = useTheme();

	const toasterStyle: React.CSSProperties & Record<`--${string}`, string | number> = {
		'--normal-bg': 'var(--popover)',
		'--normal-text': 'var(--popover-foreground)',
		'--normal-border': 'var(--border)',
		'--border-radius': 'var(--radius)',
	};
	return (
		<Sonner
			theme={theme === 'light' || theme === 'dark' ? theme : 'system'}
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			style={toasterStyle}
			toastOptions={{
				classNames: {
					toast: 'cn-toast',
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
