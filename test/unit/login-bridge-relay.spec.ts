/**
 * login-bridge-relay.spec.ts（v1.31 F4 测试——方案 §六-1/§六-2）
 *
 * 1. 哑字节透传（真 net 对穿：echo 目标 + relay，含二进制/大块/断连）
 * 2. 空闲自关（无连接+超时 → active=false + onIdleClose）
 * 3. stop 幂等语义
 * 4. 占用端口 → login_relay_port_in_use 可教学错误
 */
import { describe, it, expect, afterEach } from "vitest";
import * as Net from "node:net";
import { createLoginRelay } from "../../src/login-bridge/relay.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = Net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as Net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = Net.createServer((c) => {
      c.on("data", (d) => c.write(d));
    });
    s.listen(0, "127.0.0.1", () => {
      resolve({
        port: (s.address() as Net.AddressInfo).port,
        close: () => new Promise((r) => s.close(() => r())),
      });
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("哑 TCP 转发——字节透传（方案 F2 定谳形态）", () => {
  it("echo 往返：client→relay→目标→relay→client 逐字节保真", async () => {
    const echo = await echoServer();
    const port = await freePort();
    const relay = await createLoginRelay({ host: "127.0.0.1", port, cdpPort: echo.port, idleMs: -1 });
    cleanups.push(relay.stop);
    const got = await new Promise<Buffer>((resolve, reject) => {
      const c = Net.connect(port, "127.0.0.1", () => c.write(Buffer.from("hello-bytes")));
      const chunks: Buffer[] = [];
      c.on("data", (d) => {
        chunks.push(d);
        c.end();
      });
      c.on("error", reject);
      c.on("close", () => resolve(Buffer.concat(chunks)));
    });
    expect(got.toString()).toBe("hello-bytes");
    expect(relay.state().connections).toBeGreaterThanOrEqual(0);
  });

  it("二进制大块（64KB）透传不丢不改", async () => {
    const echo = await echoServer();
    const port = await freePort();
    const relay = await createLoginRelay({ host: "127.0.0.1", port, cdpPort: echo.port, idleMs: -1 });
    cleanups.push(relay.stop);
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const got = await new Promise<Buffer>((resolve, reject) => {
      const c = Net.connect(port, "127.0.0.1", () => c.write(payload));
      const chunks: Buffer[] = [];
      let size = 0;
      c.on("data", (d) => {
        chunks.push(d);
        size += d.length;
        if (size >= payload.length) c.end();
      });
      c.on("error", reject);
      c.on("close", () => resolve(Buffer.concat(chunks)));
    });
    expect(got.length).toBe(payload.length);
    expect(got.equals(payload)).toBe(true);
  });
});

describe("relay 生命周期", () => {
  it("空闲自关：无连接+超 idleMs → active=false 且 onIdleClose 触发", async () => {
    const echo = await echoServer();
    const port = await freePort();
    let idleClosed = false;
    const relay = await createLoginRelay({
      host: "127.0.0.1",
      port,
      cdpPort: echo.port,
      idleMs: 80,
      checkIntervalMs: 30,
      onIdleClose: () => {
        idleClosed = true;
      },
    });
    cleanups.push(async () => {
      await relay.stop();
      await echo.close();
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(relay.state().active).toBe(false);
    expect(idleClosed).toBe(true);
  });

  it("stop 后 active=false；重复 stop 不抛", async () => {
    const echo = await echoServer();
    const port = await freePort();
    const relay = await createLoginRelay({ host: "127.0.0.1", port, cdpPort: echo.port, idleMs: -1 });
    await relay.stop();
    expect(relay.state().active).toBe(false);
    await expect(relay.stop()).resolves.toBeUndefined();
    await echo.close();
  });

  it("占用端口 → login_relay_port_in_use（可教学错误）", async () => {
    const blocker = await echoServer();
    const relay = createLoginRelay({ host: "127.0.0.1", port: blocker.port, cdpPort: 1, idleMs: -1 });
    await expect(relay).rejects.toMatchObject({ code: "login_relay_port_in_use" });
    await blocker.close();
  });
});
