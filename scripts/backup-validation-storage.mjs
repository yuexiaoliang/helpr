import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// 用于受管验证入口。容量故障只能发生在已核对映像、挂载点和不同设备的自有卷。
export function guardCapacity({ image, mount, root, actualImage, actualMount, volumeBytes, volumeDevice, hostDevice }) {
  assert(path.isAbsolute(root) && image === path.join(root, 'capacity.dmg'), 'OWN_IMAGE_REQUIRED');
  assert(mount.startsWith(`/private/tmp/helpr-workspace-validation-${process.getuid()}/backup07-volume-`), 'OWN_MOUNT_REQUIRED');
  assert(actualImage === image && actualMount === mount, 'ATTACHED_IMAGE_MISMATCH');
  assert(volumeBytes > 0 && volumeBytes <= 32 * 1024 * 1024, 'CAPACITY_BOUND_REQUIRED');
  assert(volumeDevice !== hostDevice, 'HOST_VOLUME_FORBIDDEN');
}
export async function capacityVolume({ root, profileRoot, run, fault, save, emergency }) {
  const image = path.join(root, 'capacity.dmg');
  assert(!fs.existsSync(image), 'CAPACITY_IMAGE_EXISTS');
  const mount = fs.mkdtempSync(path.join(profileRoot, 'backup07-volume-'));
  const state = {image, mount, attached:false, filled:false, released:false, detached:false};
  const jsonPlist = async raw => JSON.parse(await run('/usr/bin/plutil', ['-convert','json','-o','-','-'], {input:raw}));
  async function attached() {
    const info = await jsonPlist(await run('/usr/bin/hdiutil', ['info','-plist']));
    return info.images?.find(row => path.resolve(row['image-path']) === image);
  }
  async function identify() {
    const entry = await attached();
    const entity = entry?.['system-entities']?.find(row => row['mount-point'] === mount);
    assert(entity?.['dev-entry']?.match(/^\/dev\/disk\d+s?\d*$/), 'OWN_DEVICE_REQUIRED');
    const stats = fs.statfsSync(mount);
    guardCapacity({image,mount,root,actualImage:entry['image-path'],actualMount:fs.realpathSync(mount),volumeBytes:stats.blocks*stats.bsize,volumeDevice:fs.statSync(mount).dev,hostDevice:fs.statSync(profileRoot).dev});
    state.device = entity['dev-entry'];
    state.attached = true;
    state.volumeBytes = stats.blocks*stats.bsize;
    save(state);
  }
  async function cleanup() {
    const entry = await attached();
    if (entry) {
      const entity = entry['system-entities']?.find(row => row['mount-point'] === mount);
      assert(entity?.['dev-entry'] === state.device || !state.device, 'CLEANUP_DEVICE_CHANGED');
      const device = entity?.['dev-entry'];
      assert(device?.match(/^\/dev\/disk\d+s?\d*$/), 'CLEANUP_OWN_DEVICE_REQUIRED');
      try { await run('/usr/bin/hdiutil', ['detach',device]); }
      catch (error) { state.normalDetachError = error.message; emergency(); await run('/usr/bin/hdiutil', ['detach','-force',device]); }
    }
    assert(!(await attached()), 'CAPACITY_IMAGE_STILL_ATTACHED');
    state.detached = true;
    save(state);
    if (fs.existsSync(image)) fs.unlinkSync(image);
    if (fs.existsSync(mount)) { assert(fs.readdirSync(mount).length===0,'MOUNT_NOT_EMPTY_AFTER_DETACH');fs.rmdirSync(mount); }
    state.reclaimed = true;
    save(state);
  }
  try {
    await run('/usr/bin/hdiutil', ['create','-size','16m','-fs','HFS+','-volname','helpr-backup-07','-format','UDRW','-nospotlight',image]);
    assert(fs.statSync(image).size <= 32*1024*1024, 'IMAGE_SIZE_BOUND');
    await run('/usr/bin/hdiutil', ['attach',image,'-nobrowse','-noautoopen','-mountpoint',mount,'-plist']);
    await identify();
    fault('isolated-storage-full', {mount,device:state.device});
    const file = path.join(mount,'owned-capacity-fill');
    const fd = fs.openSync(file,'wx',0o600);
    let written=0, noSpace=false;
    try {
      for (const size of [1024*1024,4096]) {
        const chunk = Buffer.alloc(size);
        while (written < 32*1024*1024) {
          try { const count=fs.writeSync(fd,chunk);assert(count>0,'CAPACITY_NO_PROGRESS');written+=count; }
          catch(error) {if(error.code!=='ENOSPC')throw error;noSpace=true;break;}
        }
      }
      try{fs.fsyncSync(fd);}catch(error){if(error.code!=='ENOSPC')throw error;noSpace=true;}
    } finally {fs.closeSync(fd);}
    assert(noSpace && written <= 32*1024*1024,'REAL_ENOSPC_REQUIRED');
    let probe;
    try {assert.throws(()=>{probe=fs.openSync(path.join(mount,'owned-space-probe'),'wx',0o600);fs.writeSync(probe,Buffer.from('x'));},error=>error.code==='ENOSPC','REAL_SMALL_WRITE_ENOSPC_REQUIRED');}
    finally {if(probe!==undefined)fs.closeSync(probe);}
    state.written=written;state.filled=true;state.remainingBytes=fs.statfsSync(mount).bavail*fs.statfsSync(mount).bsize;save(state);
    return {state,mount,cleanup,release:async()=>{
      await identify();
      for(const file of ['owned-capacity-fill','owned-space-probe'])if(fs.existsSync(path.join(mount,file)))fs.unlinkSync(path.join(mount,file));
      state.released=true;state.freeBytes=fs.statfsSync(mount).bavail*fs.statfsSync(mount).bsize;assert(state.freeBytes>1024*1024,'CAPACITY_RELEASE_FAILED');save(state);
    }};
  } catch(error) {
    state.error=error.message;save(state);
    try{await cleanup();}catch(cleanupError){state.cleanupError=cleanupError.message;save(state);}
    throw error;
  }
}
