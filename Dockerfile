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

EXPOSE 8080
CMD ["/opt/venv/bin/python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
