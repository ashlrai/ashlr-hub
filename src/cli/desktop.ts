import {applyConsumerDesktopInstall, createConsumerInstallDependencies, inspectConsumerDesktopInstall,
  type ConsumerInstallDependencies, type ConsumerInstallResult} from '../core/desktop/consumer-install.js';

const USAGE = `usage: phm desktop install [--apply]

Inspect this installed CLI's original signed macOS arm64 app and paired CLI.
Inspection downloads verified artifacts into a fresh private stage. --apply
installs only when Phantom/Ashlr.app, the managed current pointer and managed
phm/ashlr links are absent, after explicit authority Stop/drain.
No builds, signing keys, credentials, PATH edits or authority restart.
`;
export function parseDesktopInstallArgs(args: readonly string[]): {apply: boolean} | null {
  if (!args.length || args.length===1 && ['help','--help','-h'].includes(args[0]!)) return null;
  if (args[0]!=='install' || args.length>2 || args.length===2 && args[1]!=='--apply') throw new Error('Invalid desktop install arguments');
  return {apply:args.length===2};
}
export async function cmdDesktop(args: string[], dependencies?: ConsumerInstallDependencies,
  emit: (result: ConsumerInstallResult)=>void|Promise<void> = value=>{console.log(JSON.stringify(value));}): Promise<number> {
  let options: ReturnType<typeof parseDesktopInstallArgs>;
  try {options=parseDesktopInstallArgs(args);} catch {console.error(USAGE);return 2;}
  if (!options) {console.log(USAGE);return 0;}
  let observed: ConsumerInstallResult;
  try {
    const deps=dependencies??createConsumerInstallDependencies();
    observed=await inspectConsumerDesktopInstall(deps);
    if (options.apply && observed.state==='ready') observed=await applyConsumerDesktopInstall(observed);
  } catch {
    observed={state:'held',version:null,reason:'consumer-unavailable',installationAccepted:false,authorityResumed:false,shell:[]};
  }
  // A failed output channel cannot retry a completed or held installation.
  try {await emit(observed);} catch {console.error('Desktop installation result channel failed.');return 1;}
  return observed.state==='ready'||observed.state==='installed'?0:1;
}
