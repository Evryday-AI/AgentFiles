import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
const injected = vi.hoisted(()=>({uuid:"11111111-1111-4111-8111-111111111111",unlink:false,link:false,diskFull:false}));
vi.mock("node:crypto",async original=>({...await original<any>(),randomUUID:()=>injected.uuid}));
vi.mock("node:fs/promises",async original=>{
  const actual=await original<any>();
  return {...actual,open:async(...args:any[])=>{if(injected.diskFull)throw Object.assign(new Error("Injected disk full"),{code:"ENOSPC"});return actual.open(...args);},link:async(...args:any[])=>{if(injected.link)throw new Error("Injected hardlink failure");return actual.link(...args);},
    unlink:async(...args:any[])=>{if(injected.unlink)throw new Error("Injected temp unlink failure");return actual.unlink(...args);}};
});
import { stageUpload, finalizeUpload, discardUpload, openDownloadStream, getStorageUsage } from "../../src/server/storage";
import { createActiveUploads } from "../../src/server/activeUploads";
let root="";
beforeEach(async()=>{injected.unlink=false;injected.link=false;injected.diskFull=false;root=await mkdtemp(join(tmpdir(),"agentfiles-storage-fault-"));});
afterEach(async()=>{injected.unlink=false;injected.link=false;injected.diskFull=false;await rm(root,{recursive:true,force:true});});
const stage=()=>stageUpload({storageRoot:root,originalName:"file.txt",stream:Readable.from(["new"]),maxBytes:10});
describe("injected storage crash windows with real filesystem",()=>{
  it("disk-full exclusive open owns no existing bytes",async()=>{
    injected.diskFull=true;const owned:string[]=[];
    await expect(stageUpload({storageRoot:root,originalName:"file.txt",stream:Readable.from(["new"]),maxBytes:10,onKey:key=>owned.push(key)})).rejects.toMatchObject({code:"ENOSPC"});
    expect(owned).toEqual([]);expect(await getStorageUsage(root)).toEqual({bytes:0});
  });
  it("a failing asynchronous disk checkpoint terminates the stream and removes its temp bytes",async()=>{
    let n=0;
    await expect(stageUpload({storageRoot:root,originalName:"file.txt",stream:Readable.from(["aa","bb"]),maxBytes:10,checkpoint:async()=>{if(++n===2)throw new Error("Injected external free-space loss");}})).rejects.toThrow("Injected external free-space loss");
    expect(await getStorageUsage(root)).toEqual({bytes:0});
  });
  it("never owns or unlinks an existing temp UUID when exclusive creation fails",async()=>{
    await mkdir(join(root,".tmp"));const key=`.tmp/${injected.uuid}.upload`;await writeFile(join(root,key),"earlier");
    const owned:string[]=[];
    const active=createActiveUploads();
    await expect(stageUpload({storageRoot:root,originalName:"file.txt",stream:Readable.from(["new"]),maxBytes:10,onKey:key=>owned.push(key),protectKey:key=>active.hold(key)})).rejects.toMatchObject({code:"EEXIST"});
    expect(active.has(key)).toBe(false);
    expect(owned).toEqual([]);expect(await readFile(join(root,key),"utf8")).toBe("earlier");
  });
  it("exclusive final link collision preserves earlier bytes and grants no ownership",async()=>{
    const staged=await stage();await mkdir(join(root,"files"));const key=`files/${injected.uuid}.txt`;await writeFile(join(root,key),"earlier");
    const active=createActiveUploads();const owned:string[]=[];await expect(finalizeUpload(root,staged,key=>owned.push(key),key=>active.hold(key))).rejects.toMatchObject({code:"EEXIST"});
    expect(active.has(key)).toBe(false);
    expect(owned).toEqual([]);expect(await readFile(join(root,key),"utf8")).toBe("earlier");
    await discardUpload(root,staged.tempKey);expect(await getStorageUsage(root)).toEqual({bytes:7});
  });
  it("failed temp unlink after a real link leaves both owned names visible for compensation",async()=>{
    const staged=await stage();injected.unlink=true;const owned:string[]=[];
    await expect(finalizeUpload(root,staged,key=>owned.push(key))).rejects.toThrow("Injected temp unlink failure");
    expect(owned).toHaveLength(1);expect(await readFile(join(root,owned[0]),"utf8")).toBe("new");
    expect(await readFile(join(root,staged.tempKey),"utf8")).toBe("new");
    injected.unlink=false;await discardUpload(root,owned[0]);await discardUpload(root,staged.tempKey);expect(await getStorageUsage(root)).toEqual({bytes:0});
  });
  it("a failed hardlink leaves the staged bytes and no final name",async()=>{
    const staged=await stage();injected.link=true;await expect(finalizeUpload(root,staged)).rejects.toThrow("Injected hardlink failure");
    expect(await getStorageUsage(root)).toEqual({bytes:3});
  });
  it("restart measurement charges a process stop between final link and metadata",async()=>{
    const saved=await finalizeUpload(root,await stage());expect(await getStorageUsage(root)).toEqual({bytes:3});
    expect(await readFile(join(root,saved.storageKey),"utf8")).toBe("new");
  });
  it("rejects a junction ancestor for read, delete, staging, and scans",async context=>{
    await mkdir(join(root,"sentinel"));await writeFile(join(root,"sentinel","safe.txt"),"earlier");
    try{await symlink(join(root,"sentinel"),join(root,"alias"),process.platform==="win32"?"junction":"dir");}
    catch(error){if(["EPERM","ENOTSUP","EACCES"].includes((error as any).code)){context.skip();return;}throw error;}
    await expect(openDownloadStream(root,"alias/safe.txt")).rejects.toThrow("Invalid storage key.");
    await expect(discardUpload(root,"alias/safe.txt")).rejects.toThrow("Invalid storage key.");
    await expect(getStorageUsage(root)).rejects.toThrow("Invalid storage key.");
    await symlink(join(root,"sentinel"),join(root,".tmp"),process.platform==="win32"?"junction":"dir");
    await expect(stage()).rejects.toThrow("Invalid storage key.");
    expect(await readFile(join(root,"sentinel","safe.txt"),"utf8")).toBe("earlier");
    // A mount reached THROUGH a junction is unsafe even when its leaf is regular.
    await expect(getStorageUsage(join(root,"alias"))).rejects.toThrow("Invalid storage key.");
  });
});
