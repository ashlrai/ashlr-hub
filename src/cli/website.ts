/** Commission once, then operate Auto/Pause without repeatedly signing or clearing global Stop. */
import { displaySurfaceTarget } from '../core/authority/effective-config.js';
import { buildStandingGrantDraft } from '../core/verse/authority-api.js';
import { signGrant } from '../core/authority/custody-client.js';
import { describeGrantScope, installStandingGrant, parseStandingGrantPayload } from '../core/authority/standing-grant.js';
import { prepareWebsiteCommission } from '../core/website/host-adapter.js';
import { requestWebsitePublication, saveWebsiteCommission, readWebsiteCommission, websiteScope, websiteStatus, setWebsiteMode, scheduleWebsitePublication } from '../core/website/host-release.js';

export async function cmdWebsite(args: string[]): Promise<number> {
  const command = args[0] ?? 'status';
  try {
    if (command === 'status') { console.log(JSON.stringify(websiteStatus())); return 0; }
    if (['auto','pause','off'].includes(command)) {
      setWebsiteMode(command === 'pause' ? 'paused' : command as 'auto' | 'off');
      console.log(JSON.stringify(websiteStatus())); return 0;
    }
    if (command === 'request' && args.length === 2) {
      console.log(JSON.stringify(requestWebsitePublication({ profile: 'phantom-public-web', expectedMerge: args[1] }))); return 0;
    }
    if (command === 'run' && args.length === 1) { await scheduleWebsitePublication(); console.log(JSON.stringify(websiteStatus())); return 0; }
    if (command === 'prepare' && args.length === 3 && args[1] === '--image') {
      const commission = await prepareWebsiteCommission({ image: args[2]! }); saveWebsiteCommission(commission);
      console.log(JSON.stringify({ state: 'prepared', profileDigest: commission.profileDigest, builderQualification: commission.builderQualification, next: 'phm website commission --yes' })); return 0;
    }
    if (command === 'commission' && args.length === 2 && args[1] === '--yes') {
      const commission = readWebsiteCommission(); if (!commission) throw new Error('Prepare and qualify the website publisher first');
      const draft = await buildStandingGrantDraft('auto');
      const parsed = parseStandingGrantPayload({ ...draft.payload, websitePublication: websiteScope(commission) });
      if (!parsed.ok) throw new Error(parsed.reason);
      console.log(describeGrantScope(parsed.value).join('\n'));
      const signed = await signGrant(parsed.value);
      const installed = installStandingGrant(signed, { surface: displaySurfaceTarget() });
      if (!installed.ok) throw new Error(installed.reason);
      setWebsiteMode('auto');
      console.log(JSON.stringify(websiteStatus())); return 0;
    }
    console.error('Usage: phm website status|auto|pause|off|request <merge SHA>|run|prepare --image <sha256:digest>|commission --yes'); return 2;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Website publication is unavailable'); return 1; }
}
