FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY data ./data
COPY static ./static

# Hugging Face Spaces expects the app on this port.
EXPOSE 7860

# Single worker: the catalogue is loaded once at import and held in memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
