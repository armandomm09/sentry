# docker/face-service/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# ── Base Python requirements (CPU ORT included) ──────────────────────────────
# System libs needed by OpenCV headless and insightface.
# build-essential / g++ are needed to compile insightface's Cython extension;
# they are removed after the pip install to keep the image lean.
COPY face-service/requirements.txt ./requirements.txt

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        curl \
        wget \
        build-essential \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── GPU path: aarch64 ORT patch (only when GPU=1) ────────────────────────────
ARG GPU=0
ARG ORT_AARCH64_WHEEL_URL="https://github.com/ultralytics/assets/releases/download/v0.0.0/onnxruntime_gpu-1.24.0-cp312-cp312-linux_aarch64.whl"

COPY docker/face-service/patch_ort.py /tmp/patch_ort.py

RUN if [ "$GPU" = "1" ]; then \
        echo "=== GPU build: installing aarch64 ORT GPU wheel ===" && \
        # Step 1: GPU wheel — has CUDA .so but no __init__.py
        pip install --no-cache-dir --no-deps "$ORT_AARCH64_WHEEL_URL" && \
        # Step 2: CPU ORT for __init__.py (compatible with GPU pybind ABI)
        pip install --no-cache-dir "onnxruntime==1.23.2" && \
        # Step 3: Patch ABI-tagged .so with GPU .so
        python /tmp/patch_ort.py && \
        # Step 4: CUDA runtime libs (cuDNN 9, cuBLAS) — entrypoint adds to LD_LIBRARY_PATH
        pip install --no-cache-dir "nvidia-cudnn-cu12>=9" "nvidia-cublas-cu12"; \
    fi

# ── Pre-bake buffalo_l model (~600 MB, cached as image layer) ─────────────────
ENV INSIGHTFACE_HOME=/root/.insightface
RUN python - <<'PY'
import os
os.environ["INSIGHTFACE_HOME"] = "/root/.insightface"
from insightface.app import FaceAnalysis
app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1, det_size=(640, 640))
print("buffalo_l model ready")
PY

# ── Application code ──────────────────────────────────────────────────────────
COPY face-service/face_service/ ./face_service/
COPY docker/face-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8090

ENV FACE_SERVICE_HOST=0.0.0.0 \
    FACE_SERVICE_PORT=8090 \
    FACE_SERVICE_DATA_DIR=/app/data \
    INSIGHTFACE_HOME=/root/.insightface

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "face_service"]
