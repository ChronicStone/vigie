export { VigieModule } from './src/module.js'
export { resolveConfig, type VigieConfig, type VigieOptions } from './src/config.js'
export { task, VigieTask, skipTask, retryTask, type TaskInfo, type TaskOutcome } from './src/tasks.js'
export { runWithWideEvent, useLogger, getActiveTraceContext } from './src/execution.js'
