#!/bin/sh
# docker/face-service/entrypoint.sh
# Adds pip-installed NVIDIA library paths to LD_LIBRARY_PATH so ORT's
# CUDAExecutionProvider can find cuDNN and cuBLAS at runtime.
SITE=$(python -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || true)
for pkg in cudnn cublas; do
    lib_dir="$SITE/nvidia/$pkg/lib"
    if [ -d "$lib_dir" ]; then
        export LD_LIBRARY_PATH="$lib_dir:${LD_LIBRARY_PATH:-}"
    fi
done
exec "$@"
