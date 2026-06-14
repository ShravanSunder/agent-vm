import type { ManagedObservabilityRuntimeConfig } from './observability-config.js';

const SENSITIVE_FIELD_NAMES = [
	'Authorization',
	'Cookie',
	'Set-Cookie',
	'X-Api-Key',
	'access_token',
	'api_key',
	'apikey',
	'authorization',
	'body',
	'client_secret',
	'cookie',
	'db.statement',
	'http.request.body',
	'http.request.header.authorization',
	'http.response.body',
	'http.response.header.set_cookie',
	'id_token',
	'message',
	'payload',
	'password',
	'private_key',
	'refresh_token',
	'secret',
	'set-cookie',
	'token',
	'url.full',
	'url.query',
	'x-api-key',
] as const;

const OTEL_COLLECTOR_GRPC_CONTAINER_PORT = 4317;
const OTEL_COLLECTOR_HTTP_CONTAINER_PORT = 4318;
const OTEL_COLLECTOR_HEALTH_CONTAINER_PORT = 13_133;

export interface OtelCollectorConfigModel {
	readonly receivers: {
		readonly otlp: {
			readonly protocols: {
				readonly grpc: { readonly endpoint: string };
				readonly http: { readonly endpoint: string };
			};
		};
	};
	readonly processors: {
		readonly 'resource/drop-sensitive-fields': {
			readonly attributes: readonly OtelCollectorAttributeAction[];
		};
		readonly 'attributes/drop-sensitive-fields': {
			readonly actions: readonly OtelCollectorAttributeAction[];
		};
		readonly 'transform/drop-log-body': {
			readonly log_statements: readonly {
				readonly context: 'log';
				readonly statements: readonly string[];
			}[];
		};
	};
	readonly exporters: {
		readonly otlphttp: {
			readonly encoding: 'proto';
			readonly compression: 'gzip';
			readonly metrics: { readonly metricsEndpoint: string };
			readonly logs: {
				readonly logsEndpoint: string;
				readonly headers: Record<string, string>;
			};
			readonly traces: { readonly tracesEndpoint: string };
		};
	};
	readonly extensions: {
		readonly health_check: { readonly endpoint: string };
	};
	readonly service: {
		readonly extensions: readonly string[];
		readonly pipelines: {
			readonly metrics: OtelCollectorPipeline;
			readonly logs: OtelCollectorPipeline;
			readonly traces: OtelCollectorPipeline;
		};
	};
}

export interface OtelCollectorAttributeAction {
	readonly action: 'delete';
	readonly key: string;
}

export interface OtelCollectorPipeline {
	readonly receivers: readonly string[];
	readonly processors: readonly string[];
	readonly exporters: readonly string[];
}

export function createOtelCollectorConfigModel(
	_config: ManagedObservabilityRuntimeConfig,
): OtelCollectorConfigModel {
	const sensitiveFieldHeader = SENSITIVE_FIELD_NAMES.join(',');

	return {
		receivers: {
			otlp: {
				protocols: {
					grpc: { endpoint: `0.0.0.0:${String(OTEL_COLLECTOR_GRPC_CONTAINER_PORT)}` },
					http: { endpoint: `0.0.0.0:${String(OTEL_COLLECTOR_HTTP_CONTAINER_PORT)}` },
				},
			},
		},
		processors: {
			'resource/drop-sensitive-fields': {
				attributes: SENSITIVE_FIELD_NAMES.map((fieldName) => ({
					action: 'delete',
					key: fieldName,
				})),
			},
			'attributes/drop-sensitive-fields': {
				actions: SENSITIVE_FIELD_NAMES.map((fieldName) => ({
					action: 'delete',
					key: fieldName,
				})),
			},
			'transform/drop-log-body': {
				log_statements: [
					{
						context: 'log',
						statements: ['set(body, "")'],
					},
				],
			},
		},
		exporters: {
			otlphttp: {
				encoding: 'proto',
				compression: 'gzip',
				metrics: { metricsEndpoint: 'http://victoria-metrics:8428/opentelemetry/v1/metrics' },
				logs: {
					logsEndpoint: 'http://victoria-logs:9428/insert/opentelemetry/v1/logs',
					headers: { 'VL-Ignore-Fields': sensitiveFieldHeader },
				},
				traces: { tracesEndpoint: 'http://victoria-traces:10428/insert/opentelemetry/v1/traces' },
			},
		},
		extensions: {
			health_check: {
				endpoint: `0.0.0.0:${String(OTEL_COLLECTOR_HEALTH_CONTAINER_PORT)}`,
			},
		},
		service: {
			extensions: ['health_check'],
			pipelines: {
				metrics: {
					receivers: ['otlp'],
					processors: ['resource/drop-sensitive-fields', 'attributes/drop-sensitive-fields'],
					exporters: ['otlphttp/metrics'],
				},
				logs: {
					receivers: ['otlp'],
					processors: [
						'resource/drop-sensitive-fields',
						'attributes/drop-sensitive-fields',
						'transform/drop-log-body',
					],
					exporters: ['otlphttp/logs'],
				},
				traces: {
					receivers: ['otlp'],
					processors: ['resource/drop-sensitive-fields', 'attributes/drop-sensitive-fields'],
					exporters: ['otlphttp/traces'],
				},
			},
		},
	};
}

function renderStringArray(indent: string, values: readonly string[]): readonly string[] {
	return values.map((value) => `${indent}- ${value}`);
}

function renderAttributeActions(
	indent: string,
	actions: readonly OtelCollectorAttributeAction[],
): readonly string[] {
	return actions.flatMap((action) => [
		`${indent}- key: ${action.key}`,
		`${indent}  action: ${action.action}`,
	]);
}

function renderPipeline(name: string, pipeline: OtelCollectorPipeline): readonly string[] {
	return [
		`    ${name}:`,
		'      receivers:',
		...renderStringArray('        ', pipeline.receivers),
		'      processors:',
		...renderStringArray('        ', pipeline.processors),
		'      exporters:',
		...renderStringArray('        ', pipeline.exporters),
	];
}

export function renderOtelCollectorConfigYaml(config: OtelCollectorConfigModel): string {
	const lines = [
		'receivers:',
		'  otlp:',
		'    protocols:',
		`      grpc: { endpoint: "${config.receivers.otlp.protocols.grpc.endpoint}" }`,
		`      http: { endpoint: "${config.receivers.otlp.protocols.http.endpoint}" }`,
		'processors:',
		'  resource/drop-sensitive-fields:',
		'    attributes:',
		...renderAttributeActions(
			'      ',
			config.processors['resource/drop-sensitive-fields'].attributes,
		),
		'  attributes/drop-sensitive-fields:',
		'    actions:',
		...renderAttributeActions(
			'      ',
			config.processors['attributes/drop-sensitive-fields'].actions,
		),
		'  transform/drop-log-body:',
		'    log_statements:',
		...config.processors['transform/drop-log-body'].log_statements.flatMap((statementGroup) => [
			`      - context: ${statementGroup.context}`,
			'        statements:',
			...statementGroup.statements.map((statement) => `          - ${JSON.stringify(statement)}`),
		]),
		'exporters:',
		'  otlphttp/metrics:',
		`    encoding: ${config.exporters.otlphttp.encoding}`,
		`    compression: ${config.exporters.otlphttp.compression}`,
		`    metrics_endpoint: ${config.exporters.otlphttp.metrics.metricsEndpoint}`,
		'  otlphttp/logs:',
		`    encoding: ${config.exporters.otlphttp.encoding}`,
		`    compression: ${config.exporters.otlphttp.compression}`,
		`    logs_endpoint: ${config.exporters.otlphttp.logs.logsEndpoint}`,
		'    headers:',
		`      VL-Ignore-Fields: ${config.exporters.otlphttp.logs.headers['VL-Ignore-Fields']}`,
		'  otlphttp/traces:',
		`    encoding: ${config.exporters.otlphttp.encoding}`,
		`    compression: ${config.exporters.otlphttp.compression}`,
		`    traces_endpoint: ${config.exporters.otlphttp.traces.tracesEndpoint}`,
		'extensions:',
		'  health_check:',
		`    endpoint: ${config.extensions.health_check.endpoint}`,
		'service:',
		'  extensions:',
		...renderStringArray('    ', config.service.extensions),
		'  pipelines:',
		...renderPipeline('metrics', config.service.pipelines.metrics),
		...renderPipeline('logs', config.service.pipelines.logs),
		...renderPipeline('traces', config.service.pipelines.traces),
	];
	return `${lines.join('\n')}\n`;
}
