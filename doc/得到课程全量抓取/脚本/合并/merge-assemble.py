#!/usr/bin/env python3
"""merge-assemble.py — 路线 b′ 终局组装（pypdf：前言+分片合并 + 页码盖章 + 两级书签）。

用法：.venv/bin/python merge-assemble.py <assemble-spec.json>
spec：{final, front, overlay, skipStampPages:[1], shards:[{pdf,label,chapters:[{title,page}]}]}
页码语义：overlay 第 i 页叠到成品第 i 页（1 基），skipStampPages 跳过（封面不编页码）。
"""
import json
import sys

from pypdf import PdfReader, PdfWriter


def main() -> None:
    spec = json.load(open(sys.argv[1]))
    writer = PdfWriter()
    parts = [spec["front"]] + [s["pdf"] for s in spec["shards"]]
    for p in parts:
        writer.append(PdfReader(p))

    n_pages = len(writer.pages)
    overlay = PdfReader(spec["overlay"])
    assert len(overlay.pages) == n_pages, f"overlay {len(overlay.pages)} != book {n_pages}"
    skip = set(spec.get("skipStampPages", []))
    stamped = 0
    for i in range(n_pages):
        if (i + 1) in skip:
            continue
        writer.pages[i].merge_page(overlay.pages[i])
        stamped += 1

    for s in spec["shards"]:
        mod = writer.add_outline_item(s["label"], s["chapters"][0]["page"] - 1)
        for ch in s["chapters"]:
            writer.add_outline_item(ch["title"], ch["page"] - 1, parent=mod)

    with open(spec["final"], "wb") as f:
        writer.write(f)
    print(json.dumps({
        "final": spec["final"], "pages": n_pages, "stamped": stamped,
        "bytes": len(open(spec["final"], "rb").read()),
        "bookmarks": sum(len(s["chapters"]) for s in spec["shards"]) + len(spec["shards"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
