import { z } from 'zod';

export const instructionResetPhaseSchema = z.enum(['plan', 'work', 'wrapup', 'all']).default('all');

export type InstructionResetPhase = z.infer<typeof instructionResetPhaseSchema>;
