#!/usr/bin/env python3
"""Print cheapest Vast offers that fit the Phase 0 gate. Does not create an instance.

Need: >=32 GB RAM (this Mac OOMs at 16 GB), >=100 GB disk, download >=200 Mbps.
GPU is optional. The gate is CPU HF greedy vs CPU ORT; GPU is only a speed
experiment after one fixture stays token-identical.
"""

from __future__ import annotations

import json
import subprocess
import sys

QUERY = "cpu_ram>=32 disk_space>=80 inet_down>=200 dph_total<=0.12"


def main() -> int:
    proc = subprocess.run(
        ["vastai", "search", "offers", QUERY, "--raw"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        return proc.returncode
    offers = json.loads(proc.stdout)
    offers.sort(key=lambda row: row.get("dph_total", 99))
    print(f"query: {QUERY}")
    print(f"matches: {len(offers)}")
    print("USD/h  GPU              RAM  VRAM  vCPU  downMbps  diskGB  id")
    for row in offers[:12]:
        print(
            f"{row.get('dph_total', 0):6.4f}  "
            f"{str(row.get('gpu_name') or '-'):16}  "
            f"{(row.get('cpu_ram') or 0)/1024:3.0f}G  "
            f"{(row.get('gpu_ram') or 0)/1024:4.0f}G  "
            f"{row.get('cpu_cores') or 0:4}  "
            f"{row.get('inet_down') or 0:8.0f}  "
            f"{row.get('disk_space') or 0:6.0f}  "
            f"{row.get('id')}"
        )
    if not offers:
        return 1
    best = offers[0]
    print()
    print("cheapest id:", best.get("id"))
    print("do not create from here; rsync first, then:")
    print(
        f"  vastai create instance {best.get('id')} "
        "--image pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime "
        "--disk 80 --ssh"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
