import { command, constant, object, or } from '@optique/core';

import {
	cliDescription,
	createConfigOption,
	createPresenceFlag,
	createPurgeFlag,
	createZoneOption,
} from './command-definition-support.js';

const controllerZoneOptionsParser = object({
	config: createConfigOption(),
	zone: createZoneOption(),
});
const controllerConfigOptionsParser = object({ config: createConfigOption() });

export const controllerCommandParser = command(
	'controller',
	or(
		command(
			'start',
			object({ command: constant('controller.start'), options: controllerZoneOptionsParser }),
			{ description: cliDescription('Boot the controller and gateway') },
		),
		command(
			'stop',
			object({ command: constant('controller.stop'), options: controllerConfigOptionsParser }),
			{ description: cliDescription('Stop the controller') },
		),
		command(
			'cleanup',
			object({
				command: constant('controller.cleanup'),
				options: object({
					config: createConfigOption(),
					force: createPresenceFlag(
						'--force',
						'Allow cleanup even if the controller health endpoint is reachable',
					),
					zone: createZoneOption(),
				}),
			}),
			{
				description: cliDescription(
					'Reconcile exact VM ownership without contacting the controller',
				),
			},
		),
		command(
			'status',
			object({ command: constant('controller.status'), options: controllerConfigOptionsParser }),
			{ description: cliDescription('Show controller status') },
		),
		command(
			'health',
			object({ command: constant('controller.health'), options: controllerZoneOptionsParser }),
			{ description: cliDescription('Run the configured live gateway health probe for a zone') },
		),
		command(
			'health-snapshot',
			object({
				command: constant('controller.health-snapshot'),
				options: controllerZoneOptionsParser,
			}),
			{ description: cliDescription('Show the latest in-memory health snapshot for a zone') },
		),
		command(
			'service-health',
			object({
				command: constant('controller.service-health'),
				options: controllerZoneOptionsParser,
			}),
			{ description: cliDescription('Run the live gateway service liveness probe for a zone') },
		),
		command(
			'ssh',
			object({
				command: constant('controller.ssh'),
				options: controllerZoneOptionsParser,
			}),
			{ description: cliDescription('Open an SSH session into the gateway VM') },
		),
		command(
			'destroy',
			object({
				command: constant('controller.destroy'),
				options: object({
					config: createConfigOption(),
					purge: createPurgeFlag(),
					zone: createZoneOption(),
				}),
			}),
			{ description: cliDescription('Destroy a zone runtime') },
		),
		command(
			'upgrade',
			object({ command: constant('controller.upgrade'), options: controllerZoneOptionsParser }),
			{ description: cliDescription('Upgrade a zone runtime') },
		),
		command(
			'logs',
			object({ command: constant('controller.logs'), options: controllerZoneOptionsParser }),
			{ description: cliDescription('Show gateway logs') },
		),
		command(
			'credentials',
			or(
				command(
					'check',
					object({
						command: constant('controller.credentials.check'),
						options: controllerZoneOptionsParser,
					}),
					{
						description: cliDescription(
							'Check zone credential resolution without refreshing the gateway',
						),
					},
				),
				command(
					'refresh',
					object({
						command: constant('controller.credentials.refresh'),
						options: controllerZoneOptionsParser,
					}),
					{ description: cliDescription('Refresh zone credentials') },
				),
			),
			{ description: cliDescription('Manage credentials') },
		),
	),
	{ description: cliDescription('Manage the VM controller') },
);
