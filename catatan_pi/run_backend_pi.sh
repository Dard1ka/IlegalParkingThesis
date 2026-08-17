#!/usr/bin/env bash
# REPLIKA perintah start backend di Raspberry Pi (log b3cbe55e L500/L599/L638, 17 Agu 2026).
cd ~/Illegal_Parking
source parking/bin/activate
export LD_PRELOAD=$(for f in $(find ~/Illegal_Parking/parking -name "*.so*" 2>/dev/null); do nm -D "$f" 2>/dev/null | grep -qE ' [TWtw] sbgemm_' && echo "$f" && break; done)
uvicorn backend.main:app --host 0.0.0.0 --port 8000
