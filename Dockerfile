FROM ghcr.io/osgeo/gdal:ubuntu-small-latest

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY fetch.py /app/fetch.py
COPY container/requirements.txt /app/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/requirements.txt
COPY container/server.py /app/server.py

# The GDAL subprocesses and the AOI/output tempdirs never need root.
RUN useradd --system --create-home --home-dir /home/appuser appuser \
    && chown -R appuser:appuser /app
USER appuser
ENV HOME=/home/appuser

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD /opt/venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)" || exit 1
CMD ["/opt/venv/bin/python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
