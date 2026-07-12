import { ControllerExecutionResultSchema } from '../../controller-dispatch-boundary/models/controller-execution-result-schema.js';

export const ControllerHostActionResultSchema = ControllerExecutionResultSchema;

export type ControllerHostActionResult = typeof ControllerHostActionResultSchema._output;
