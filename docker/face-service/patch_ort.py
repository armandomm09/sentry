# docker/face-service/patch_ort.py
"""Replace the CPU ABI-tagged pybind .so with the GPU .so.

After installing onnxruntime-gpu (step 1, no-deps) and onnxruntime CPU
(step 2, for __init__.py), Python prefers the ABI-tagged CPU .so. This
script replaces it with the GPU .so so the CUDA EP is loaded.
"""
import os
import shutil

import onnxruntime  # noqa: F401 — import to resolve path

capi_dir = os.path.join(os.path.dirname(onnxruntime.__file__), "capi")
gpu_so = os.path.join(capi_dir, "onnxruntime_pybind11_state.so")
abi_so = os.path.join(
    capi_dir, "onnxruntime_pybind11_state.cpython-312-aarch64-linux-gnu.so"
)

if not os.path.exists(gpu_so):
    print(f"ERROR: GPU .so not found at {gpu_so}")
    raise SystemExit(1)

if not os.path.exists(abi_so):
    print(f"ERROR: ABI .so not found at {abi_so}")
    raise SystemExit(1)

gpu_size = os.path.getsize(gpu_so)
abi_size = os.path.getsize(abi_so)

if gpu_size > abi_size:
    shutil.copy(gpu_so, abi_so)
    print(f"Patched: GPU .so ({gpu_size} B) → ABI .so path")
else:
    print(f"WARN: GPU .so ({gpu_size} B) not larger than ABI .so ({abi_size} B). Skipping.")

# Skip Python teardown — the GPU pybind11 .so (now loaded) will segfault
# when finalizing without a CUDA runtime present (e.g. during a Docker build).
# The patch work is done; a clean exit is all we need.
os._exit(0)
