import { z } from 'zod';

export const secretsProviderSchema = z.enum(['1password', 'environment']);
export type SecretsProvider = z.infer<typeof secretsProviderSchema>;

export const imageArchitectureSchema = z.enum(['aarch64', 'x86_64']);
export type ImageArchitecture = z.infer<typeof imageArchitectureSchema>;

export const scaffoldGatewayTypeSchema = z.enum(['hermes', 'worker']);
export type GatewayType = z.infer<typeof scaffoldGatewayTypeSchema>;

export const hostSystemTypeSchema = z.enum(['bare-metal', 'container']);
export type HostSystemType = z.infer<typeof hostSystemTypeSchema>;

export const scaffoldPathModeSchema = z.enum(['local', 'pod', 'user-dir']);
export type ScaffoldPathMode = z.infer<typeof scaffoldPathModeSchema>;
