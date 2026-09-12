/** Fixed, read-only manager workload. This is not a console execution host. */
import { isAbsolute, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../../src/core/foundry/provenance.js';
import { canonical, digest } from '../../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringPreparation } from '../../src/core/resources/console-engineering-preparation.js';
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringOwner } from '../../src/core/resources/console-engineering.js';
import { matchesResourceConsoleProject, pinResourceConsoleProject, validateResourceConsoleProjects } from '../../src/core/resources/console-projects.js';
import { readResourceJson } from '../../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../../src/core/resources/worker.js';
import type { ResourcePoolSupervisor } from '../../src/core/resources/pool-supervisor.js';

type Options = Omit<Parameters<typeof createResourceConsoleEngineeringPreparation>[0], 'owner'>;
type Manager = ReturnType<typeof createResourceConsoleEngineeringPreparation>;
const required = ['configFile', 'config', 'root', 'workspace', 'projectsFile', 'poolFile', 'bindingsFile', 'observationsFile'];

function copy<T>(value: unknown): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > 256 * 1024) throw new Error('Invalid preparation workflow data');
  return JSON.parse(text) as T;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function options(input: unknown): Options {
  const value = copy<Record<string, unknown>>(input);
  if (!exact(value, [...required, ...(Object.hasOwn(value, 'quotaConfigFile') ? ['quotaConfigFile'] : [])]) ||
    Object.entries(value).some(([key, path]) => key !== 'config' && (typeof path !== 'string' ||
      path.length > 4096 || !isAbsolute(path) || resolve(path) !== path || path === parse(path).root ||
      [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)))) {
    throw new Error('Invalid preparation workflow options');
  }
  return value as unknown as Options;
}

/**
 * Fixture seam: real pinned project directories and pool files back the two
 * supervisor reads required by the real owner. No supervisor is constructed,
 * no persisted policy is represented as execution permission, and all other
 * capabilities refuse. The owner still validates every restored catalog and
 * registration using its ordinary production implementation.
 */
function readOnlySupervisor(value: Options): ResourcePoolSupervisor {
  const document = readResourceJson(value.projectsFile, 256 * 1024);
  if (!exact(document, ['schemaVersion', 'projects']) || document.schemaVersion !== 1) {
    throw new Error('Invalid preparation workflow projects');
  }
  const projects = [{ id: 'default', label: 'Default workspace', workspace: value.workspace },
    ...validateResourceConsoleProjects(document.projects)].map(pinResourceConsoleProject);
  const pool = validateResourcePool(readResourceJson(value.poolFile));
  const bindings = validateResourceBindings(readResourceJson(value.bindingsFile), pool);
  const poolDigest = digest(canonical({ pool, bindings }));
  const refuse = (): never => { throw new Error('Preparation workflow execution is disabled'); };
  return {
    projects: () => projects.map(project => ({ id: project.id, label: project.label, workspace: project.workspace, enabled: true })),
    engineeringBinding(id) {
      const project = projects.find(row => row.id === id);
      if (!project || !matchesResourceConsoleProject(project)) throw new Error('Preparation workflow project changed');
      return { project: { ...project }, root: value.root, poolDigest };
    },
    snapshot: refuse, projectFileBinding: refuse, projectExecutionBinding: refuse,
    submit: refuse, cancel: refuse, setPaused: refuse, output: refuse,
    history: refuse, deleteHistory: refuse, close: refuse,
  };
}

/** Construction is measured only by explicit open; imports/factory do no I/O. */
export function createPreparationWorkflow() {
  let manager: Manager | undefined;
  let owner: ResourceConsoleEngineeringOwner | undefined;
  let opening = false;
  let closing: Promise<null> | undefined;
  function current(): { manager: Manager; owner: ResourceConsoleEngineeringOwner } {
    if (!manager || !owner || opening || closing) throw new Error('Preparation workflow is not open');
    return { manager, owner };
  }
  return {
    async open(input: unknown) {
      if (owner || opening || closing) throw new Error('Preparation workflow is already open');
      opening = true;
      let created: ResourceConsoleEngineeringOwner | undefined;
      try {
        const value = options(input);
        created = createResourceConsoleEngineeringOwner({
          registrationEnabled: true, supervisor: readOnlySupervisor(value), root: value.root,
          poolFile: value.poolFile, bindingsFile: value.bindingsFile, observationsFile: value.observationsFile,
          ...(value.quotaConfigFile === undefined ? {} : { quotaConfigFile: value.quotaConfigFile }),
        });
        const restored = createResourceConsoleEngineeringPreparation({ ...value, owner: created });
        const result = copy<{ catalog: ReturnType<ResourceConsoleEngineeringOwner['catalog']> }>({ catalog: created.catalog() });
        owner = created; manager = restored;
        return result;
      } catch (error) { await created?.close(); throw error; }
      finally { opening = false; }
    },
    check(input: unknown) { return copy<ReturnType<Manager['check']>>(current().manager.check(copy(input))); },
    replay(input: unknown) {
      const active = current(); const request = copy<Record<string, unknown>>(input);
      // A fresh prepare would write. Only IDs genuinely restored by this owner
      // can reach the manager's ordinary exact-request/digest replay checks.
      if (!request || typeof request.id !== 'string' || !active.owner.catalog().some(row => row.id === request.id)) {
        throw new Error('Preparation workflow requires an existing registration');
      }
      const result = active.manager.prepare(request);
      if (result.disposition !== 'replayed') throw new Error('Preparation workflow created unexpected registration');
      return copy<ReturnType<Manager['prepare']>>(result);
    },
    close(): Promise<null> {
      if (closing) return closing;
      if (opening) return Promise.reject(new Error('Preparation workflow is opening'));
      const active = owner; manager = undefined; owner = undefined;
      closing = Promise.resolve().then(() => active?.close()).then(() => null).finally(() => { closing = undefined; });
      return closing;
    },
  };
}
