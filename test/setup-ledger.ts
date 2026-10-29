/**
 * 全局测试 setup（2026-10-29 提案 v2：台账读点对账的测试逃生口）。
 *
 * readLedgerSync 现内建探活对账（死 pid 条目读取即销账）——27 个既有 spec 以
 * 假 pid（111/222/9991…）播种台账后裸调 readLedgerSync，若真实探活则记录在
 * 读点被销、断言全碎。本 setup 全局注入恒活判活 = 恢复旧 readLedgerSync 语义
 * （零探活零销账），既有 spec 零改动保持现状行为；对账测试（chrome-ledger-
 * reconcile.spec.ts）显式覆盖钩子后 afterEach 恢复恒活。
 *
 * 生产语义不受影响：__setLedgerAliveFnForTests 在 src/ 生产代码零调用
 * （INV-111(d) 防线锚）。
 */
import { __setLedgerAliveFnForTests } from "../src/launcher/chrome-ledger.js";

__setLedgerAliveFnForTests(() => true);
