# Self-contained image: React build + FastAPI + a real headless Blender.
#
# Blender is downloaded from blender.org rather than installed from apt, because
# distro packages lag well behind and this service depends on operators that
# only exist in 4.2+ (wm.stl_export, USD orientation conversion). Pinning the
# exact build is what makes conversions reproducible.

# --- stage 1: the SPA -------------------------------------------------------
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- stage 2: runtime -------------------------------------------------------
FROM python:3.13-slim

ARG BLENDER_SERIES=5.2
ARG BLENDER_VERSION=5.2.1

# Blender links against X11 and GL even in background mode, so these are
# required despite there being no display.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils ca-certificates \
        libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 \
        libgl1 libegl1 libsm6 libice6 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
      "https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /opt \
    && mv "/opt/blender-${BLENDER_VERSION}-linux-x64" /opt/blender \
    && rm -rf /opt/blender/blender.shared/locale \
    && /opt/blender/blender --version

ENV BLENDER_PATH=/opt/blender/blender \
    CONVERTER_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY backend/ /app/backend/
RUN pip install --no-cache-dir -e /app/backend

# The backend serves this directly, so one container is the whole app.
COPY --from=ui /ui/dist /app/frontend/dist

# Uploads and results live here; mount a volume to keep them across restarts.
RUN mkdir -p /data && useradd -r -u 10001 convert && chown -R convert /data
USER convert
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=5).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8080"]
