# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Profit Guild — production image
#
# Zero third-party dependencies: the server is pure Python standard library,
# so the image is just the Python base plus the static site.
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="Profit Guild funnel" \
      org.opencontainers.image.description="Static marketing funnel + zero-dependency lead API" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/app/data \
    LOG_LEVEL=INFO

WORKDIR /app

# Only the files the server actually needs at runtime.
COPY server.py ./
COPY index.html 404.html thank-you.html legal.html ./
COPY styles.css script.js config.js ./
COPY robots.txt sitemap.xml site.webmanifest ./
COPY assets ./assets

# Run as an unprivileged user that owns the data directory.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python3 -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','4173')}/api/health\",timeout=4).read()" || exit 1

CMD ["python3", "server.py"]
