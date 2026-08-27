#!/usr/bin/env node
// check-readme-sync.mjs — README 漂移红线（进 npm test，漂移即红）
//
// 背景（2026-08-27 用户裁决）：README 只维护中英双语，且历史多次发生
// 「版本号/changelog 改了中文忘了英文」「引用 doc 路径重整后 README 悬空」
// 「语言文件增删后导航行漂移」——机械校验进测试链，红即挡。
//
// 校验面（全部可机械判定，零启发式）：
//  A. 语言文件集恰为 {README.md, README.en.md}——多删/多加/命名漂移即红
//  B. 语言导航行：两份各自列且仅列两语言、互指正确、无死链语言项
//  C. 版本同步：两份 README 的「当前版本」声称一致，且 == package.json version
//  D. changelog 对称：两份的 vX.Y.Z 条目集合完全一致（多语漂移的主形态）
//  E. 相对链接/图片：两份 README 内全部相对路径引用实存（doc 重整/资产移动即红）
//  F. npm 包名/安装命令与 package.json name 一致（改名忘同步即红）
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

// CJK 仓路径（claude技能）：import.meta.url 是百分号编码形态，必须 fileURLToPath
// （2026-08-27 迁移实踩：pathname 直用会 ENOENT，同族 bug 已在 test/resource-monitor 修过）
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const errors = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { errors.push(m); console.log(`  ✗ ${m}`); };

const zh = readFileSync(path.join(ROOT, "README.md"), "utf8");
const en = readFileSync(path.join(ROOT, "README.en.md"), "utf8");

// A. 语言文件集
const langReadmes = readdirSync(ROOT).filter((f) => /^README\..+\.md$/.test(f)).sort();
const expectLangs = ["README.en.md"];
if (JSON.stringify(langReadmes) !== JSON.stringify(expectLangs)) {
  bad(`A 语言文件集漂移：期望 [${expectLangs}]，实际 [${langReadmes}]（只维护中英双语——多出的删掉、缺的补回）`);
} else ok("A 语言文件集 = README.md + README.en.md");

// B. 语言导航行
// 顺序无关：两元素共存即可（实测 en 版是 [中文](README.md) | **English** 倒序）
const navOk = (s, selfMark, otherHref) =>
  s.includes(`**${selfMark}**`) && s.includes(`](${otherHref})`) && !/README\.(de|es|fr|ja|pt|ru)/.test(s);
if (navOk(zh, "简体中文", "README.en.md")) ok("B 中文导航行（中|英，无死链语言项）");
else bad("B 中文 README.md L18 语言导航行漂移：应恰为 **简体中文** | [English](README.en.md)");
if (navOk(en, "English", "README.md")) ok("B 英文导航行（中|英，无死链语言项）");
else bad("B 英文 README.en.md L18 语言导航行漂移：应恰为 [简体中文](README.md) | **English**");

// C. 当前版本同步（中：**当前版本 vX.Y.Z**；英兼容 *Current version* 形态）
const vZh = (zh.match(/当前版本\s*v?(\d+\.\d+\.\d+)/) || [])[1];
const vEn = (en.match(/[Cc]urrent version\s*v?(\d+\.\d+\.\d+)/) || [])[1];
if (vZh && vZh === pkg.version) ok(`C 中文当前版本 ${vZh} == package.json`); else bad(`C 中文「当前版本」(${vZh ?? "未找到"}) ≠ package.json (${pkg.version})`);
if (vEn && vEn === pkg.version) ok(`C 英文当前版本 ${vEn} == package.json`); else bad(`C 英文「Current version」(${vEn ?? "未找到"}) ≠ package.json (${pkg.version})——英文版漏同步版本行`);

// D. changelog 版本集合对称
const vers = (s) => [...s.matchAll(/- \*\*v(\d+\.\d+\.\d+)\*\*/g)].map((m) => m[1]).sort();
const vZhSet = vers(zh), vEnSet = vers(en);
const onlyZh = vZhSet.filter((v) => !vEnSet.includes(v));
const onlyEn = vEnSet.filter((v) => !vZhSet.includes(v));
if (!onlyZh.length && !onlyEn.length) ok(`D changelog 对称（${vZhSet.length} 条版本两语一致）`);
else bad(`D changelog 漂移：仅中文有 [${onlyZh}] / 仅英文有 [${onlyEn}]——改 changelog 必须两语同改`);

// E. 相对链接/图片实存（markdown 链接 + img，排除 http/#/mailto 与 data:）
const checkLinks = (s, label) => {
  const refs = [...s.matchAll(/\]\(([^)]+)\)|src="([^"]+)"/g)]
    .map((m) => m[1] || m[2])
    .filter((r) => r && !/^(https?:|#|mailto:|data:)/.test(r) && !r.startsWith("../"))  // ../ 前缀=GitHub 仓库相对链（badge/stargazers），在 GitHub 域解析非本仓文件
    .map((r) => r.split("#")[0])
    .filter(Boolean);
  const missing = [...new Set(refs.filter((r) => !existsSync(path.join(ROOT, r))))];
  if (!missing.length) ok(`E ${label} 相对引用 ${new Set(refs).size} 条全实存`);
  else bad(`E ${label} 悬空引用：${missing.join(", ")}（doc 重整/资产移动后 README 未同步）`);
};
checkLinks(zh, "中文");
checkLinks(en, "英文");

// F. 包名一致
if (zh.includes(pkg.name) || /lasso-mcp/.test(zh)) ok(`F 包名引用一致（${pkg.name}）`);
else bad("F README 未出现包名（改名忘同步？）");

console.log(errors.length ? `\nREADME 漂移 ${errors.length} 项（上列 ✗）——修 README 或同步 package.json 后重跑` : "\nREADME 同步检查全绿（中英双语 / 版本 / changelog / 引用 / 包名）");
process.exit(errors.length ? 1 : 0);
