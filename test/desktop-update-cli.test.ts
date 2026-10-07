import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { cmdDesktopUpdate, parseDesktopUpdateArgs, desktopUpdateJsonWriter } from '../src/cli/desktop-update.js';
import type { DesktopUpdateDependencies } from '../src/core/desktop/qualified-update.js';

afterEach(()=>vi.restoreAllMocks());
const dependencies:DesktopUpdateDependencies={home:'/private/owned',platform:'darwin',architecture:'arm64',packageRoot:'/owned/package',trust:null,
  admission:()=>{throw new Error('unexpected admission');},currentPackageRoot:()=>null,captureParent:()=>null,verifyParent:async()=>false,parentState:()=> 'unknown',now:Date.now,sleep:async()=>{},
  download:async()=>{throw new Error('network forbidden');}};
describe('installed desktop-update CLI contract',()=>{
  it.each(['inspect','apply'] as const)('accepts the fixed %s opaque-ID JSON request',verb=>{
    expect(parseDesktopUpdateArgs([verb,'--stage','a'.repeat(32),'--json'])).toEqual({verb,stage:'a'.repeat(32)});
  });
  it.each([
    ['apply','--stage','../path','--json'],['apply','--stage','A'.repeat(32),'--json'],['apply','--stage','a'.repeat(32)],
    ['apply','--stage','a'.repeat(32),'--json','--json'],['apply','--url','https://github.com','--json'],
    ['apply','--stage','a'.repeat(32),'--pid','42','--json'],['apply','--stage','a'.repeat(32),'--help'],
    ['inspect','--stage','a'.repeat(32),'--json','--shell','echo'],['unknown','--stage','a'.repeat(32),'--json'],
  ])('refuses ambiguity or caller authority %j',args=>expect(()=>parseDesktopUpdateArgs(args)).toThrow());
  it('handles help without dependency or transport reads',async()=>{
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});expect(await cmdDesktopUpdate(['--help'],dependencies)).toBe(0);
    expect(log).toHaveBeenCalledOnce();expect(log.mock.calls[0]?.[0]).toContain('No URL, path, shell');
  });
  it.each(['inspect','apply'])('outputs only fixed blocked metadata when trust unavailable (%s)',async verb=>{
    const emit=vi.fn();expect(await cmdDesktopUpdate([verb,'--stage','a'.repeat(32),'--json'],dependencies,emit)).toBe(1);
    expect(emit).toHaveBeenCalledOnce();expect(emit).toHaveBeenCalledWith({schema:'phantom-desktop-update-result/v1',state:'blocked',version:null,reason:'trust-not-commissioned',requiresReapproval:false});
  });
  it('awaits actual stream writes and consumes only its own closed-pipe error lifecycle',async()=>{
    const stream=new Writable({write(_chunk,_encoding,callback){callback(Object.assign(new Error('closed'),{code:'EPIPE'}));}});
    const writer=desktopUpdateJsonWriter(stream);
    expect(stream.listenerCount('error')).toBe(1);
    await expect(writer.write({schema:'phantom-desktop-update-result/v1',state:'blocked',version:null,reason:'trust-not-commissioned',requiresReapproval:false})).rejects.toMatchObject({code:'EPIPE'});
    await writer.dispose();expect(stream.listenerCount('error')).toBe(0);
  });
  it('does not silently swallow an unrelated JSON output failure',async()=>{
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(await cmdDesktopUpdate(['inspect','--stage','a'.repeat(32),'--json'],dependencies,async()=>{throw Object.assign(new Error('private test reason'),{code:'EIO'});})).toBe(1);
    expect(error).toHaveBeenCalledWith('Desktop update result channel failed.');
  });
  it('returns usage 2 with no inspection for unsupported operands',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});const emit=vi.fn();expect(await cmdDesktopUpdate(['apply','--path','/tmp','--json'],dependencies,emit)).toBe(2);expect(emit).not.toHaveBeenCalled();
  });
});
