FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
RUN mkdir -p /app/data/media

ENV KARAOKE_MEDIA_ROOT=/app/data/media
EXPOSE 8790

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8790"]
