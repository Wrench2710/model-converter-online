FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends assimp-utils libgl1 libglib2.0-0 default-libmysqlclient-dev pkg-config build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /app/media/sources /app/media/artifacts
