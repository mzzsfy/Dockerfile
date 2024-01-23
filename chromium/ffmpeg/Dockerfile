FROM debian:bullseye

ENV LANG=C.UTF-8

RUN apt-get update && apt-get install --no-install-recommends -y chromium chromium-driver ffmpeg xvfb && rm -rf /var/lib/apt/lists/*
