import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createIntegrationFixture, syntheticMultipart } from "../helpers/integration";
import { createFileRecord, UploadAllocationUncertainError, reconcileUpload } from "../../src/server/filesRepo";
import { stageUpload, finalizeUpload, getStorageUsage } from "../../src/server/storage";
import type { UploadRuntime } from "../../src/server/uploadRuntime";
import type { Database, Queryable } from "../../src/server/db";
import { buildServer } from "../../src/server/index";
import { recordSafeEvent } from "../../src/server/events";

const limits = { maxUploadBytes:10, maxStorageBytes:150, minFreeDiskBytes:0 };
const runtime = (f: Awaited<ReturnType<typeof createIntegrationFixture>>) => f.server.getDecorator<UploadRuntime>("uploadRuntime");
async function empty(f: Awaited<ReturnType<typeof createIntegrationFixture>>) {
  expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(0);
  expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(0);
  expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:0});
  expect(runtime(f).admission.snapshot()).toEqual({managedBytes:0,reservedBytes:0,active:0});
}
async function send(f: Awaited<ReturnType<typeof createIntegrationFixture>>, body: ReturnType<typeof syntheticMultipart>) {
  const key = await f.createSyntheticKey(["can_upload"]);
  return f.server.inject({method:"POST",url:"/api/files",headers:{...key.headers,...body.headers},payload:body.payload});
}
function allocated(storageKey: string) {
  return {originalName:"synthetic.txt",storageKey,mimeType:"text/plain",sizeBytes:5,uploadedByType:"api_key" as const,expiresAt:new Date(Date.now()+86400000)};
}
describe("bounded upload with real PostgreSQL and disk", () => {
  it.each(["normal", "immediate", "deferred"] as const)("confirmed %s upload records one safe creation event or visible failure", async mode => {
    for (const eventFailure of [false, true]) {
      let unavailable = mode === "deferred";
      const f = await createIntegrationFixture(limits, {files:{repo:{
        createFileRecord: async (input, db) => {
          const record = await createFileRecord(input, db);
          if (mode !== "normal") throw new UploadAllocationUncertainError(new Error("synthetic committed reply loss"));
          return record;
        },
        reconcileUpload: async (...args) => {
          if (unavailable) throw new Error("synthetic ownership verification outage");
          return reconcileUpload(...args);
        },
      }}});
      try {
        if (eventFailure) await f.db.query(`CREATE FUNCTION synthetic_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$;
          CREATE TRIGGER synthetic_failure BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_event_failure()`);
        const response = await send(f, syntheticMultipart("hello"));
        expect(response.statusCode).toBe(mode === "deferred" ? 503 : 201);
        if (mode === "deferred") {
          expect(response.json().code).toBe("UPLOAD_OUTCOME_UNKNOWN");
          expect(runtime(f).unresolvedCount()).toBe(1);
          expect((await f.db.query("SELECT * FROM events")).rows).toHaveLength(0);
          unavailable = false;
          await runtime(f).retryUnknown();
        }
        await runtime(f).retryUnknown();
        expect(runtime(f).unresolvedCount()).toBe(0);
        expect(runtime(f).admission.snapshot()).toEqual({managedBytes:5,reservedBytes:0,active:0});
        const record = (await f.db.query<any>("SELECT * FROM files")).rows[0];
        expect(record.lifecycle_state).toBe("active");
        expect(await readFile(join(f.storageRoot,record.storage_key),"utf8")).toBe("hello");
        expect(runtime(f).activeUploads.has(record.storage_key)).toBe(false);
        expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(1);
        const state = f.server.getDecorator<any>("maintenance").state;
        expect(state.eventFailures).toBe(eventFailure ? 1 : 0);
        expect((await f.db.query("SELECT * FROM events WHERE file_id=$1",[record.id])).rows).toHaveLength(eventFailure ? 0 : 1);
        if (!eventFailure) await recordSafeEvent({fileId:record.id,eventType:"file.created",actorType:"api_key"},f.db,state);
        const events = (await f.db.query<any>("SELECT * FROM events WHERE file_id=$1",[record.id])).rows;
        expect(events).toHaveLength(eventFailure ? 0 : 1);
        if (!eventFailure) expect(events[0]).toMatchObject({event_type:"file.created",actor_type:"api_key",actor_name:null,details:{}});
      } finally { await f.close(); }
    }
  });
  it("remeasures temporary and orphan final bytes on a fresh server before admission",async()=>{
    const f=await createIntegrationFixture({...limits,maxStorageBytes:15});let restarted:ReturnType<typeof buildServer>|undefined;
    try{
      await f.server.close();await mkdir(join(f.storageRoot,".tmp"));await mkdir(join(f.storageRoot,"files"));
      await writeFile(join(f.storageRoot,".tmp","interrupted.upload"),"aaaa");
      // A dedicated child really exits after finalization and before metadata.
      const result=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",
        "import {Readable} from 'node:stream'; import {stageUpload,finalizeUpload} from './src/server/storage.ts'; const root=process.argv[1]; const staged=await stageUpload({storageRoot:root,originalName:'synthetic.txt',maxBytes:10,stream:Readable.from(['bbb'])}); const final=await finalizeUpload(root,staged); console.log(JSON.stringify(final)); process.exit(0);",f.storageRoot],
        {cwd:process.cwd(),env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,timeout:5000});
      const orphan=JSON.parse(result.stdout);expect(await readFile(join(f.storageRoot,orphan.storageKey),"utf8")).toBe("bbb");
      expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(0);expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(0);
      restarted=buildServer(f.config,{db:f.db});await restarted.ready();
      const fresh=restarted.getDecorator<UploadRuntime>("uploadRuntime");expect(fresh.admission.snapshot().managedBytes).toBe(7);
      const key=await f.createSyntheticKey(["can_upload"]),body=syntheticMultipart("x");
      const response=await restarted.inject({method:"POST",url:"/api/files",headers:{...key.headers,...body.headers},payload:body.payload});
      expect(response.statusCode).toBe(507);expect(response.json().code).toBe("STORAGE_CAPACITY_EXCEEDED");expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:7});
    }finally{await restarted?.close();await f.close();}
  });
  it("stores hostile filename/MIME as inert metadata and downloads only as an attachment", async () => {
    const f = await createIntegrationFixture(limits);
    try {
      const key = await f.createSyntheticKey(["can_upload", "can_download"]);
      const body = syntheticMultipart("hello");
      body.payload = Buffer.from(body.payload.toString()
        .replace('filename="synthetic.txt"', 'filename="../../hostile.SVG"')
        .replace("Content-Type: text/plain", "Content-Type: text/html; invalid=unsafe"));
      const response = await f.server.inject({
        method: "POST", url: "/api/files",
        headers: { ...key.headers, ...body.headers }, payload: body.payload,
      });
      expect(response.statusCode).toBe(201);
      const record = response.json();
      const download = await f.server.inject({
        method: "GET", url: `/api/files/${record.code}/download`, headers: key.headers,
      });
      expect(download.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(download.body).toBe("hello");
      const rows = await f.db.query<{ storage_key: string }>("SELECT storage_key FROM files");
      expect(rows.rows[0].storage_key).toMatch(/^files\/[a-f0-9-]{36}\.svg$/);
    } finally {
      await f.close();
    }
  });
  it.each(["abort", "idle", "lying-length"])("cleans incomplete real network upload: %s", async kind => {
    const f = await createIntegrationFixture(
      { ...limits, maxUploadBytes: 100 }, { files: { uploadIdleTimeoutMs: 150 } },
    );
    try {
      const key = await f.createSyntheticKey(["can_upload"]);
      const body = syntheticMultipart("hello");
      await f.server.listen({ host: "127.0.0.1", port: 0 });
      const address = f.server.server.address();
      if (!address || typeof address === "string") throw new Error();
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1", port: address.port, path: "/api/files", method: "POST",
          headers: {
            ...key.headers, ...body.headers,
            ...(kind === "lying-length" ? { "content-length": body.payload.length - 10 } : {}),
          },
        }, res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", error => kind === "abort" ? resolve(undefined) : reject(error));
        if (kind === "lying-length") {
          req.end(body.payload);
          return;
        }
        req.write(body.payload.subarray(0, body.payload.indexOf(Buffer.from("hello")) + 3));
        if (kind === "abort") setTimeout(() => req.destroy(), 50);
      });
      if (kind === "idle") expect(status).toBe(408);
      if (kind === "lying-length") expect(status).toBe(400);
      // Abort has no HTTP response; await release of the server's actual lease.
      for (let n = 0; n < 100 && runtime(f).admission.snapshot().active; n++) {
        await new Promise(r => setTimeout(r, 10));
      }
      await empty(f);
    } finally {
      await f.close();
    }
  });
  it.each([9,10,11])("uses real chunked HTTP and exact file cap %i", async size => {
    const f = await createIntegrationFixture(limits);
    try {
      const key = await f.createSyntheticKey(["can_upload"]), body = syntheticMultipart("x".repeat(size));
      await f.server.listen({host:"127.0.0.1",port:0});
      const address = f.server.server.address(); if(!address || typeof address === "string") throw new Error();
      const response = await new Promise<{status:number;body:string}>( (resolve,reject) => {
        const req = httpRequest({host:"127.0.0.1",port:address.port,path:"/api/files",method:"POST",headers:{...key.headers,...body.headers}},res=>{
          let text="";res.on("data",chunk=>{text+=chunk;});res.on("end",()=>resolve({status:res.statusCode!,body:text}));
        });req.on("error",reject);
        // No Content-Length: several independent chunked network writes.
        const offset = body.payload.indexOf(Buffer.from("x".repeat(size)));
        req.write(body.payload.subarray(0,offset));
        req.write(body.payload.subarray(offset,offset+4));
        setImmediate(()=>{req.write(body.payload.subarray(offset+4));req.end();});
      });
      expect(response.status).toBe(size>10?413:201);
      if(size>10) await empty(f);
      else {expect(JSON.parse(response.body).size_bytes).toBe(size); expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:size});}
    } finally {await f.close();}
  });
  it.each(["unknown", "prototype", "duplicate", "oversized", "second", "denied", "broken"])("never finalizes after parser/policy failure: %s", async kind => {
    let finalized=0;
    const f=await createIntegrationFixture({...limits,maxUploadBytes:kind==="broken"?100:10},{files:{uploadIdleTimeoutMs:kind==="broken"?100:undefined,storage:{finalizeUpload:async(...args)=>{finalized++;return finalizeUpload(...args);}}}});
    try {
      const body=syntheticMultipart("hello"), boundary="synthetic-integration-boundary";
      const field=(name:string,value:string)=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      const extra = kind==="unknown"?field("unexpected","yes"):kind==="prototype"?field("__proto__","yes"):kind==="duplicate"?field("durable","false")+field("durable","false"):kind==="oversized"?field("durable","x".repeat(5000)):kind==="denied"?field("durable","true"):kind==="second"?`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="second.txt"\r\n\r\nsecond\r\n`:"";
      body.payload=Buffer.from(body.payload.toString().replace(`--${boundary}--\r\n`,kind==="broken"?"--unfinished":extra+`--${boundary}--\r\n`));
      const res=await send(f,body);
      expect(res.statusCode).toBe(kind==="denied"?403:["oversized","second"].includes(kind)?413:400);
      expect(finalized).toBe(0);await empty(f);
    }finally{await f.close();}
  });
  it("compensates real staged/final bytes on injected hardlink and metadata failures", async()=>{
    for(const fault of ["link","metadata"]){
      const f=await createIntegrationFixture(limits,{files:{...(fault==="metadata"?{repo:{createFileRecord:async()=>{throw new Error("Injected metadata failure");}}}:{storage:{finalizeUpload:async()=>{throw new Error("Injected link failure");}}})}});
      try{expect((await send(f,syntheticMultipart("hello"))).statusCode).toBe(500);await empty(f);}finally{await f.close();}
    }
  });
  it("retains and charges failed compensation, preserving the original allocation error", async()=>{
    const f=await createIntegrationFixture(limits,{files:{repo:{createFileRecord:async()=>{throw new Error("Injected metadata failure");}},storage:{discardUpload:async()=>{throw new Error("Injected unlink failure");}}}});
    try{
      const res=await send(f,syntheticMultipart("hello"));expect(res.statusCode).toBe(500);expect(res.json()).toEqual({error:"Operation failed"});
      expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:5});
      expect(runtime(f).admission.snapshot().managedBytes).toBe(5);
      expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(0);
    }finally{await f.close();}
  });
  it("holds max reservations across byte completion until metadata and compensates delayed failure", async()=>{
    let release!:()=>void, entered!:()=>void;
    const barrier=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
    const f=await createIntegrationFixture({...limits,maxUploadBytes:100,maxStorageBytes:150},{files:{repo:{createFileRecord:async()=>{entered();await barrier;throw new Error("Injected delayed SQL failure");}}}});
    try{
      const key=await f.createSyntheticKey(["can_upload"]),body=syntheticMultipart("hello");
      const first=f.server.inject({method:"POST",url:"/api/files",headers:{...key.headers,...body.headers},payload:body.payload});
      await started;
      const keys=await readdir(join(f.storageRoot,"files"));expect(runtime(f).activeUploads.has(`files/${keys[0]}`)).toBe(true);
      const second=await f.server.inject({method:"POST",url:"/api/files",headers:{...key.headers,...body.headers},payload:body.payload});
      expect(second.statusCode).toBe(507);release();expect((await first).statusCode).toBe(500);await empty(f);
    }finally{release();await f.close();}
  });
  it("four real stalled allocations reject a fifth slot and commit actual bytes after release",async()=>{
    let release!:()=>void, entered!:()=>void, count=0;
    const gate=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
    const f=await createIntegrationFixture({...limits,maxStorageBytes:100},{files:{repo:{createFileRecord:async(input,db)=>{if(++count===4)entered();await gate;return createFileRecord(input,db);}}}});
    try{
      const key=await f.createSyntheticKey(["can_upload"]),body=syntheticMultipart("hello");
      const upload=()=>f.server.inject({method:"POST",url:"/api/files",headers:{...key.headers,...body.headers},payload:body.payload});
      const first=Array.from({length:4},upload);await started;
      const fifth=await upload();expect(fifth.statusCode).toBe(429);expect(fifth.json().code).toBe("UPLOAD_CONCURRENCY_LIMIT");expect(fifth.headers["retry-after"]).toBe("1");
      expect(runtime(f).admission.snapshot().reservedBytes).toBe(40);
      const keys=await readdir(join(f.storageRoot,"files"));expect(keys).toHaveLength(4);expect(keys.every(key=>runtime(f).activeUploads.has(`files/${key}`))).toBe(true);
      release();expect((await Promise.all(first)).every(response=>response.statusCode===201)).toBe(true);
      expect(runtime(f).admission.snapshot()).toEqual({managedBytes:20,reservedBytes:0,active:0});expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:20});
    }finally{release();await f.close();}
  });
  it("retries issued/concurrent candidates and bounds forced collisions without losing bytes",async()=>{
    const f=await createIntegrationFixture();
    try{
      const codes=["F-ABCDE","F-NEW22","F-THREE","F-FQUR4"];
      await f.db.query("INSERT INTO issued_file_codes(code) VALUES($1)",[codes[0]]);
      const saved=await finalizeUpload(f.storageRoot,await stageUpload({storageRoot:f.storageRoot,originalName:"one.txt",maxBytes:100,stream:Readable.from(["first"])}));
      let n=0;const first=await createFileRecord(allocated(saved.storageKey),f.db,{generateCode:()=>codes[n++]});
      expect(first.code).toBe(codes[1]);
      const two=await finalizeUpload(f.storageRoot,await stageUpload({storageRoot:f.storageRoot,originalName:"two.txt",maxBytes:100,stream:Readable.from(["other"])}));
      const three=await finalizeUpload(f.storageRoot,await stageUpload({storageRoot:f.storageRoot,originalName:"three.txt",maxBytes:100,stream:Readable.from(["third"])}));
      let a=0,b=0;
      const results=await Promise.all([createFileRecord(allocated(three.storageKey),f.db,{generateCode:()=>a++?codes[3]:codes[2]}),createFileRecord(allocated(two.storageKey),f.db,{generateCode:()=>b++?codes[3]:codes[2]})]);
      expect(new Set(results.map(r=>r.code)).size).toBe(2);
      await expect(createFileRecord(allocated("synthetic/rejected"),f.db,{generateCode:()=>codes[0]})).rejects.toMatchObject({code:"CODE_ALLOCATION_RETRY_EXHAUSTED",statusCode:503});
      await expect(createFileRecord(allocated("synthetic/exhausted"),f.db,{generateCode:()=>codes[0],namespace:codes})).rejects.toMatchObject({code:"CODE_SPACE_EXHAUSTED",statusCode:507});
      expect(await readFile(join(f.storageRoot,saved.storageKey),"utf8")).toBe("first");expect(await readFile(join(f.storageRoot,two.storageKey),"utf8")).toBe("other");
      expect(await readFile(join(f.storageRoot,three.storageKey),"utf8")).toBe("third");
    }finally{await f.close();}
  });
  it.each(["retry","exhausted","retained"])("compensates bounded registry allocation failure via real HTTP: %s",async kind=>{
    const f=await createIntegrationFixture(limits,{files:{repo:{createFileRecord:async(input,db)=>createFileRecord(input,db,{generateCode:()=>"F-ABCDE",...(kind==="exhausted"?{namespace:["F-ABCDE"]}:{})})},...(kind==="retained"?{storage:{discardUpload:async()=>{throw new Error("Injected compensation unlink failure");}}}:{})}});
    try{
      const earlier=await finalizeUpload(f.storageRoot,await stageUpload({storageRoot:f.storageRoot,originalName:"earlier.txt",maxBytes:10,stream:Readable.from(["old!!"])}));
      await createFileRecord({...allocated(earlier.storageKey),code:"F-ABCDE"},f.db);
      await runtime(f).rescan();
      const response=await send(f,syntheticMultipart("hello"));expect(response.statusCode).toBe(kind==="exhausted"?507:503);
      expect(response.json().code).toBe(kind==="exhausted"?"CODE_SPACE_EXHAUSTED":"CODE_ALLOCATION_RETRY_EXHAUSTED");
      if(kind!=="exhausted")expect(response.headers["retry-after"]).toBe("1");
      expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(1);
      expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(1);
      expect(await readFile(join(f.storageRoot,earlier.storageKey),"utf8")).toBe("old!!");
      expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:kind==="retained"?10:5});
      expect(runtime(f).admission.snapshot()).toEqual({managedBytes:kind==="retained"?10:5,reservedBytes:0,active:0});
    }finally{await f.close();}
  });
  it("rolls back unissued codes on real metadata constraint failure",async()=>{
    const f=await createIntegrationFixture();
    try{await expect(createFileRecord({...allocated("synthetic/failure"),expiresAt:null},f.db,{generateCode:()=>"F-ABCDE"})).rejects.toBeDefined();expect((await f.db.query("SELECT * FROM issued_file_codes")).rows).toHaveLength(0);}finally{await f.close();}
  });
  it.each(["before-commit","after-commit"])("distinguishes injected commit transport faults: %s",async point=>{
    const f=await createIntegrationFixture(limits,{files:{repo:{createFileRecord:async(input,db)=>{
      const database=db as Database;
      const wrapper={query:database.query,withClient:<T>(work:(pinned:Queryable)=>Promise<T>)=>database.withClient(async pinned=>work({query:async<T>(sql:string,params?:readonly unknown[])=>{
        if(sql==="COMMIT"&&point==="before-commit")throw new Error("Injected commit not sent");
        const result=await pinned.query(sql,params as unknown[]);
        if(sql==="COMMIT"&&point==="after-commit")throw new Error("Injected committed response lost");
        return {rows:result.rows as T[],rowCount:result.rowCount};
      }}))};
      return createFileRecord(input,wrapper,{generateCode:()=>"F-ABCDE"});
    }}}});
    try{
      const result=await send(f,syntheticMultipart("hello"));
      if(point==="before-commit"){expect(result.statusCode).toBe(500);await empty(f);}
      else{expect((await f.db.query("SELECT * FROM events WHERE event_type='file.created'")).rows).toHaveLength(1);expect(result.statusCode).toBe(201);expect((await f.db.query("SELECT * FROM issued_file_codes WHERE code='F-ABCDE'")).rows).toHaveLength(1);expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:5});}
    }finally{await f.close();}
  });
  it("reconciles committed response loss and retains unresolved delayed transactions until lock outcome",async()=>{
    for(const decision of ["commit","rollback"] as const){
      let release!:()=>void, entered!:()=>void;
      const gate=new Promise<void>(r=>{release=r;}), started=new Promise<void>(r=>{entered=r;});
      let background:Promise<unknown>|undefined;
      const f=await createIntegrationFixture(limits,{files:{repo:{createFileRecord:async(input,db)=>{
        background=(db as Database).withClient(async(pinned)=>{
          await pinned.query("BEGIN");await pinned.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[input.storageKey]);
          // Use a pinned allocation wrapper so a real inserted reservation is pending.
          await createFileRecord(input,{query:pinned.query.bind(pinned),withClient:async(work:any)=>work({query:async(sql:string,params?:unknown[])=>["BEGIN","COMMIT"].includes(sql)?{rows:[],rowCount:0}:pinned.query(sql,params)})} as Queryable);
          entered();await gate;await pinned.query(decision==="commit"?"COMMIT":"ROLLBACK");
        });
        await started;throw new UploadAllocationUncertainError(new Error("Injected connection uncertainty while transaction pending"));
      }}}});
      try{
        const result=await send(f,syntheticMultipart("hello"));expect(result.statusCode).toBe(503);expect(result.json().code).toBe("UPLOAD_OUTCOME_UNKNOWN");
        expect(runtime(f).unresolvedCount()).toBe(1);expect(runtime(f).admission.snapshot().reservedBytes).toBe(10);
        const keys=await readdir(join(f.storageRoot,"files"));expect(runtime(f).activeUploads.has(`files/${keys[0]}`)).toBe(true);
        expect((await f.db.query("SELECT * FROM files")).rows).toHaveLength(0); // An unlocked fresh absence is deliberately insufficient.
        expect(await getStorageUsage(f.storageRoot)).toEqual({bytes:5});
        release();await background;await runtime(f).retryUnknown();
        expect(runtime(f).unresolvedCount()).toBe(0);expect(runtime(f).admission.snapshot().reservedBytes).toBe(0);
        if(decision==="commit") {expect((await f.db.query("SELECT * FROM events WHERE event_type='file.created'")).rows).toHaveLength(1);expect((await reconcileUpload(`files/${keys[0]}`,f.db))?.sizeBytes).toBe(5);expect(await readFile(join(f.storageRoot,"files",keys[0]),"utf8")).toBe("hello");}
        else await empty(f);
      }finally{release();await background;await f.close();}
    }
  },15000);
});
