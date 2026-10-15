import { describe, expect, it } from "vitest";
import { createUploadAdmission } from "../../src/server/uploadAdmission";
const config = { maxUploadBytes: 100, maxStorageBytes: 150, minFreeDiskBytes: 20, maxConcurrentUploads: 4 };
describe("upload reservations", () => {
  it("serializes async disk checks and reserves the maximum, then converts to actual bytes", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const admission = createUploadAdmission(config, 0, async () => { await barrier; return 1000; });
    const outcomes = Promise.allSettled([admission.acquire(), admission.acquire()]);
    release();
    const result = await outcomes;
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(r => r.status === "rejected")[0]).toMatchObject({ reason: { code: "STORAGE_CAPACITY_EXCEEDED" } });
    const first = result.find(r => r.status === "fulfilled")!;
    if (first.status !== "fulfilled") throw new Error();
    await first.value.commit(10);
    expect(admission.snapshot()).toEqual({ managedBytes: 10, reservedBytes: 0, active: 0 });
    await (await admission.acquire()).abort(10);
    expect(admission.snapshot()).toEqual({ managedBytes: 20, reservedBytes: 0, active: 0 });
  });
  it("rejects the fifth stalled request and safely releases aborted slots", async () => {
    const admission = createUploadAdmission({ ...config, maxStorageBytes: 1000 }, 0, async () => 1000);
    const leases = await Promise.all(Array.from({length:4}, () => admission.acquire()));
    await expect(admission.acquire()).rejects.toMatchObject({ statusCode:429, code:"UPLOAD_CONCURRENCY_LIMIT" });
    await leases[0].abort(0);
    await (await admission.acquire()).abort(0);
    await Promise.all(leases.slice(1).map(l => l.abort(0)));
    expect(admission.snapshot().active).toBe(0);
  });
  it("fails closed on disk errors and reserve exhaustion", async () => {
    for (const free of [async () => { throw new Error("measurement failed"); }, async () => 119, async () => NaN]) {
      const admission = createUploadAdmission(config, 0, free);
      await expect(admission.acquire()).rejects.toMatchObject({ code:"STORAGE_CAPACITY_EXCEEDED" });
      expect(admission.snapshot().active).toBe(0);
    }
  });
  it("a failed rescan retains previous charges and blocks admission until a successful idle scan",async()=>{
    const admission=createUploadAdmission(config,10,async()=>1000);
    await expect(admission.rescan(async()=>{throw new Error("missing mount");})).rejects.toMatchObject({code:"STORAGE_CAPACITY_EXCEEDED"});
    expect(admission.snapshot().managedBytes).toBe(10);
    await expect(admission.acquire()).rejects.toMatchObject({code:"STORAGE_CAPACITY_EXCEEDED"});
    await admission.rescan(async()=>20);
    await (await admission.acquire()).abort(0);
    expect(admission.snapshot().managedBytes).toBe(20);
  });
  it("never subtracts active streamed bytes from reservations during a rescan",async()=>{
    const admission=createUploadAdmission(config,10,async()=>1000);
    const lease=await admission.acquire();let scanned=false;
    await admission.rescan(async()=>{scanned=true;return 50;});expect(scanned).toBe(false);
    await lease.commit(10);expect(scanned).toBe(true);expect(admission.snapshot()).toEqual({managedBytes:50,reservedBytes:0,active:0});
  });
  it("disk checkpoints fail cleanly after external free-space loss and settlement releases the charge",async()=>{
    let free=1000;const admission=createUploadAdmission(config,0,async()=>free);
    const lease=await admission.acquire();free=119;
    await expect(admission.checkpoint()).rejects.toMatchObject({code:"STORAGE_CAPACITY_EXCEEDED"});
    await lease.abort(10);expect(admission.snapshot()).toEqual({managedBytes:10,reservedBytes:0,active:0});
  });
});
