#!/usr/bin/env python3
# write-version-record.py — 生成 v2 版本记录
import json, datetime, os
OUT = "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract"
chapters = []
for tag in ["fk", "l001", "l002"]:
    m = json.load(open(f"{OUT}/v2-{tag}-meta.json"))
    chapters.append({
        "title": m["title"], "chapterDir": m["chapterDir"],
        "pdfPath": m["pdfPath"], "pdfBytes": m["pdfBytes"], "sha256": m["sha256"], "pages": m["qc"]["pages"],
        "promoDropped": m.get("promoAudit", {}).get("lastSrc"),
        "promoMd5Match": m.get("promoMd5", {}).get("match"),
        "droppedImages": [d["src"] for d in m.get("droppedImages", [])],
        "iterations": [{"iter": i["iter"], "holes": [f"p{h['page']}:{h['tailPct']}%" for h in i["holes"]]} for i in m["iterations"]],
        "bestIter": m.get("bestIter"),
        "qc": {
            "zeroLossMissingEmpty": m["qc"]["zeroLoss"]["missingEmpty"],
            "inOrder": m["qc"]["zeroLoss"]["inOrder"],
            "promoInPdf": len(m["qc"]["promo"]),
            "holes": len(m["qc"]["holes"]),
            "innerTextInvariant": m["qc"]["innerTextInvariant"],
        },
        "chunked": m["fixScreen"].get("chunked", []),
        "shrunkScreen": m["fixScreen"].get("shrunk", []),
    })
rec = {
    "version": 2,
    "producedAt": datetime.datetime.now().isoformat(timespec="seconds"),
    "pipeline": "lasso/.dedao-extract/extract-v2.mjs（batch3 清理 + JS_FIX_SCREEN 删宣传图/缩放/条带化 + pdfimages/bbox 打印反馈闭环≤2迭代 + 保最优迭代）",
    "printParams": "A4 8.268x11.693in, margin 0.4in 四边, scale 1, printBackground, preferCSSPageSize=false（batch3 同款）",
    "requirements": {
        "promo": "尾部宣传图 M2(1080x607)∧M3(src 2017022 时间窗)∧M4(最后 figure 且其后无正文) 判据删除；md5 金标 7127ed550d5aeb9b75697030579c9aa4（三章全 match）",
        "pagination": "图放不下→优先缩小（屏幕 S-A 首过 + 打印产物反馈 S-A 闭环）；超页高图条带化（chunk 88px，课程表前页 62.4% 大洞根除）；文字词级零丢失硬门禁",
        "textRedline": "pdftotext vs cleanup 态 innerText 字符多重集+保序双 diff，missing 必须为空",
    },
    "chapters": chapters,
    "history": [
        {"version": 1, "date": "2026-08-19", "note": "extract-batch3.mjs 首批（无 promo 删除/无分页修复），产物已被用户侧清理，本轮 v2 重产覆盖"},
    ],
}
p = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学/版本记录.json"
open(p, "w").write(json.dumps(rec, ensure_ascii=False, indent=2))
print("written", p, os.path.getsize(p))
