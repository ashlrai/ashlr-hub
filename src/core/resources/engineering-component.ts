/** One engineering scope. The workspace retains its supervisor and collectors. */
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringOwner } from './console-engineering.js';
import { createResourceConsoleEngineeringPreparation, type ResourceConsoleEngineeringPreparationOwner } from './console-engineering-preparation.js';
import { createResourceConsoleEngineeringSupervisor, type ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';
import { createEngineeringBackground } from './engineering-background.js';
import type { EngineeringBackground } from './engineering-background-types.js';
import { createResourceEngineeringAutomaticAdmission } from './engineering-automatic-admission.js';
import type { ResourceEngineeringLifetime } from './engineering-lifetime.js';
import { captureResourceEngineeringLifetime } from './engineering-lifetime.js';
import type { ResourceConsoleScope } from './console-types.js';

type Preparation = Pick<ResourceConsoleEngineeringPreparationOwner, 'profiles' | 'check' | 'prepare' | 'prepareAutomatically' | 'pendingAutomaticAdmissions'> |
  Pick<EngineeringBackground, 'profiles' | 'check' | 'prepare' | 'prepareAutomatically' | 'pendingAutomaticAdmissions'>;
type Admission = ReturnType<typeof createResourceEngineeringAutomaticAdmission>;
type State = NonNullable<ResourceConsoleScope['engineeringLifecycle']>;
export interface ResourceEngineeringComponentOptions {
  owner: Omit<Parameters<typeof createResourceConsoleEngineeringOwner>[0], 'isExecutionStopped' | 'waitForResourceDrain'>;
  preparation?: Omit<Parameters<typeof createResourceConsoleEngineeringPreparation>[0], 'owner'>;
  supervision?: Parameters<typeof createResourceConsoleEngineeringSupervisor>[0]['config'];
  successors?: Parameters<EngineeringBackground['configureSuccessors']>[0];
  readAdmissionEvidence: Parameters<EngineeringBackground['configureSuccessors']>[2];
  lifetime?: ResourceEngineeringLifetime;
  isWorkspaceStopped(): boolean;
  onState(state: State): void;
  onFault(): void;
}
export interface ResourceEngineeringComponent {
  readonly owner: ResourceConsoleEngineeringOwner | null;
  readonly preparation: Preparation | null;
  readonly supervision: ResourceConsoleEngineeringSupervisor | null;
  readonly admission: Admission | null;
  readonly successors: Pick<EngineeringBackground, 'snapshot' | 'start' | 'close'> | null;
  initialize(): Promise<void>;
  start(): Promise<void>;
  isStopped(): boolean;
  /** Component-only drain; never cancels ordinary workspace tasks. */
  close(): Promise<void>;
  /** Called only by workspace shutdown; joins the original whole-pool drain. */
  closeWorkspace(): Promise<void>;
  isFaulted(): boolean;
}

export function createResourceEngineeringComponent(options: ResourceEngineeringComponentOptions): ResourceEngineeringComponent {
  const { owner: ownerOptions, preparation: preparationOptions, supervision: supervisionConfig,
    successors: successorOptions, readAdmissionEvidence, isWorkspaceStopped, onState, onFault } = options;
  const lifetime = captureResourceEngineeringLifetime(options.lifetime === undefined ? {} : { engineeringLifetime: options.lifetime });
  let owner: ResourceConsoleEngineeringOwner | null = null, preparation: Preparation | null = null;
  let supervision: ResourceConsoleEngineeringSupervisor | null = null, admission: Admission | null = null;
  let background: EngineeringBackground | null = null;
  let successors: Pick<EngineeringBackground, 'snapshot' | 'start' | 'close'> | null = null;
  let closing: Promise<void> | null = null, workspaceClosing: Promise<void> | null = null;
  let initialization: Promise<void> | null = null;
  let faulted = false, initialized = false, started = false;
  let stopTimer: ReturnType<typeof setInterval> | null = null;
  const stopped = () => faulted || isWorkspaceStopped() || lifetime.isStopped() || closing !== null || workspaceClosing !== null;
  const cleanupObserver = () => {
    if (stopTimer !== null) { clearInterval(stopTimer); stopTimer = null; }
    lifetime.signal?.removeEventListener('abort', aborted);
  };
  const fault = () => {
    faulted = true;
    onState('held');
    void close().catch(() => {});
    onFault();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    cleanupObserver(); onState('stopping');
    closing = (async () => {
      // A background constructor can resolve after cancellation. Drain the actual
      // returned handle, not the null slot observed before the pending await.
      await initialization?.catch(() => {});
      const results = await Promise.allSettled([
        Promise.resolve().then(() => background?.close()),
        Promise.resolve().then(() => admission?.close()),
        Promise.resolve().then(() => supervision?.close()),
        Promise.resolve().then(() => owner?.close({ preserveSupervisorTasks: true })),
      ]);
      if (faulted || results.some(result => result.status === 'rejected')) {
        onState('held'); throw new Error('Engineering shutdown uncertain');
      }
      onState('closed');
    })();
    return closing;
  };
  const aborted = () => { void close().catch(() => {}); };
  return {
    get owner() { return owner; }, get preparation() { return preparation; },
    get supervision() { return supervision; }, get admission() { return admission; },
    get successors() { return successors; }, isStopped: stopped, isFaulted: () => faulted, close,
    initialize() {
      if (initialized || stopped()) throw new Error('Engineering initialization unavailable');
      initialized = true;
      initialization = Promise.resolve().then(async () => {
        if (stopped()) throw new Error('Engineering initialization unavailable');
        owner = createResourceConsoleEngineeringOwner({ ...ownerOptions, isExecutionStopped: stopped,
          waitForResourceDrain: async () => {
            // These references belong to this component, even after a host moves on.
            if (!closing || workspaceClosing) await Promise.all([ownerOptions.supervisor.close(), background?.close()]);
            else await background?.close();
          } });
        onState('running');
        if (preparationOptions) {
          if (successorOptions || supervisionConfig?.autoAdmitPrepared) {
            background = await createEngineeringBackground({ preparation: preparationOptions,
              owner, supervisor: ownerOptions.supervisor, isClosing: stopped, signal: ownerOptions.signal, onFault: fault });
            if (stopped()) throw new Error('Engineering initialization stopped');
            preparation = background;
          } else preparation = createResourceConsoleEngineeringPreparation({ ...preparationOptions, owner });
        }
        if (supervisionConfig) supervision = createResourceConsoleEngineeringSupervisor({ owner,
          root: ownerOptions.root, config: supervisionConfig, signal: ownerOptions.signal });
        if (supervisionConfig?.autoAdmitPrepared && preparation && supervision) {
          admission = createResourceEngineeringAutomaticAdmission({ preparation, supervision, isClosing: stopped, onFatal: fault });
        }
        if (successorOptions && background && supervision) {
          await background.configureSuccessors(successorOptions, supervision, readAdmissionEvidence);
          if (stopped()) throw new Error('Engineering initialization stopped');
          successors = background;
        }
      });
      return initialization;
    },
    async start() {
      if (!initialized || started || stopped()) throw new Error('Engineering startup unavailable');
      started = true;
      await initialization;
      if (stopped()) throw new Error('Engineering startup unavailable');
      supervision?.start(); admission?.start(); await successors?.start();
      // A startup callback can already have closed this exact component.
      if (lifetime.configured && closing === null && workspaceClosing === null) {
        lifetime.signal?.addEventListener('abort', aborted, { once: true });
        stopTimer = setInterval(() => { if (lifetime.isStopped()) aborted(); }, 250);
        stopTimer.unref?.();
        if (lifetime.isStopped()) aborted();
      }
    },
    closeWorkspace() {
      if (workspaceClosing) return workspaceClosing;
      cleanupObserver();
      workspaceClosing = (async () => {
        await initialization?.catch(() => {});
        const backgroundClosing = Promise.resolve().then(() => background?.close());
        void backgroundClosing?.catch(() => {});
        // Fence automatic preparation before awaiting worker/graph settlement.
        const admissionResult = await Promise.allSettled([Promise.resolve().then(() => admission?.close())]);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => backgroundClosing),
          Promise.resolve().then(() => supervision?.close()),
          Promise.resolve().then(() => owner?.close()),
        ]);
        if (faulted || [...admissionResult, ...results].some(result => result.status === 'rejected')) {
          onState('held'); throw new Error('Engineering shutdown uncertain');
        }
      })();
      return workspaceClosing;
    },
  };
}
