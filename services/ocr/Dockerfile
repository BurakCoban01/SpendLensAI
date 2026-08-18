FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur libglib2.0-0 libgl1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/ocr/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ocr ./services/ocr
EXPOSE 8000
CMD ["uvicorn", "services.ocr.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
