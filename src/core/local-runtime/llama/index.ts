/**
 * The supervised llama-server local serving runtime.
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * Public surface, in the order a caller usually needs it:
 *   - {@link resolveLlamaServerBaseUrl}  which runtime the fleet dispatches to
 *   - {@link startLocalRuntime} / {@link stopLocalRuntime} / {@link restartLocalRuntime}
 *   - {@link statusLocalRuntime} / {@link probeLlamaRuntime}  typed health
 *   - {@link fleetConcurrencyLimit}  the ONLY legitimate source of fleet width
 *   - {@link installLaunchAgent} / {@link uninstallLaunchAgent}  genuine 24/7
 */

export type {
  LlamaLifecycleResult,
  LlamaLivenessFacts,
  LlamaOwnershipRecord,
  LlamaRuntimeConfig,
  LlamaRuntimeOwner,
  LlamaRuntimeSnapshot,
  LlamaRuntimeState,
  LlamaSlotCapacity,
  ServingRuntimeIdentity,
} from './types.js';

export {
  DEFAULT_LLAMA_CONTEXT,
  DEFAULT_LLAMA_HOST,
  DEFAULT_LLAMA_PORT,
  DEFAULT_LLAMA_SLOTS,
  LEGACY_DEFAULT_BASE_URL,
  baseUrlFromRecord,
  buildLlamaServerArgs,
  isLoopbackHost,
  originFor,
  resolveLlamaRuntimeConfig,
  resolveLlamaServerBaseUrl,
  resolveLlamaServerBin,
  resolveLlamaServerDefaultModel,
  resolveLlamaServerOrigin,
} from './config.js';

export {
  OLLAMA_PARALLEL_REFUSAL,
  composeSnapshot,
  deriveSlotCapacity,
  fleetConcurrencyLimit,
  identifyRuntime,
  interpretHealth,
  probeLlamaRuntime,
} from './health.js';
export type { EndpointReading, FetchLike, LlamaProbeReadings, ProbeOptions } from './health.js';

export {
  DEFAULT_START_TIMEOUT_MS,
  isPortFree,
  restartLocalRuntime,
  startLocalRuntime,
  statusLocalRuntime,
  stopLocalRuntime,
} from './supervisor.js';
export type { LifecycleOptions } from './supervisor.js';

export {
  buildLaunchAgentPlist,
  buildLaunchAgentShim,
  installLaunchAgent,
  launchAgentInstalled,
  launchAgentLoaded,
  launchAgentLogPaths,
  shQuote,
  uninstallLaunchAgent,
} from './launchd.js';
export type { LaunchAgentMutation, LaunchAgentSpec } from './launchd.js';

export {
  blobBasenameForDigest,
  parseOllamaModelRef,
  resolveOllamaModelBlob,
  resolveOllamaRefForBlobPath,
  selectModelLayer,
} from './ollama-blob.js';
export type { OllamaBlobResolution, OllamaModelRef, ResolvedOllamaBlob } from './ollama-blob.js';

export {
  argvBindsPort,
  argvMatchesRecord,
  findLlamaServersOnPort,
  modelPathFromArgv,
  processAlive,
  shouldReclaim,
} from './process.js';

export {
  clearOwnershipRecord,
  parseOwnershipRecord,
  readOwnershipRecord,
  writeOwnershipRecord,
} from './record.js';

export {
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  launchAgentShimPath,
  localRuntimeDir,
  logsDir,
  ollamaModelsRoot,
  ownershipRecordPath,
  stderrLogPath,
  stdoutLogPath,
} from './paths.js';
