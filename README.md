# EduNova-AI

The Complete AI Learning Platform — an AI-powered quiz generation and learning platform.

## What it does

EduNova-AI turns study material into interactive multiple-choice quizzes. Paste in text, and the platform generates a full quiz session — questions, correct answers, and distractors — then tracks your attempts so you can reattempt a session and compare scores over time.

Platform features:

- AI quiz generation: generate 1–250 multiple-choice questions from any study text (`POST /api/v1/generate-quiz`)
- Fine-tuned T5 question generation: a bundled fine-tuned T5 model (`t5_qg_finetuned/`) produces questions, with noun-phrase answer extraction, sentence-embedding and WordNet-based distractor generation, quality scoring, and difficulty modeling
- Quiz sessions: create sessions, delete them, save completed attempts, and view per-session attempt history with score comparison
- User accounts: profiles with avatar upload (base64), email/username/password updates, and a token-based forgot/reset password flow
- Versioned REST API for users, profiles, sessions, and attempts

## Tech stack

- Backend: Python 3.11/3.12, FastAPI, Uvicorn, Pydantic v2
- AI/ML: PyTorch, Hugging Face Transformers, sentence-transformers, NLTK — fine-tuned T5 question generation with CPU/CUDA device-aware inference
- Database: SQLAlchemy 2 + Alembic migrations; SQLite locally, PostgreSQL in production
- Auth: Werkzeug password hashing, token-based password reset
- Frontend: single-page interface (`index.html`)
- Deployment: Docker, Docker Compose, Gunicorn with Uvicorn workers, Render-ready (`runtime.txt`)

## Project structure

- `app.py` — FastAPI backend (AI Quiz Generator Backend)
- `ml_engine.py` — MCQ generation pipeline: T5 question generation, noun-phrase extraction, distractor generation, quality scoring
- `difficulty_model.py` — question difficulty modeling
- `db_manage.py` — database management helpers
- `alembic/` — database migrations
- `t5_qg_finetuned/` — bundled fine-tuned T5 question-generation model
- `index.html` — frontend
- `Dockerfile`, `docker-compose.yml` — containerized deployment
- `scripts/`, `assets/` — supporting files

## Getting started

### Run locally

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn app:app --reload
```

The API is served on http://127.0.0.1:8000.

### Run with Docker Compose

Set `POSTGRES_PASSWORD` in a `.env` file (see `.env.example`), then:

```bash
docker compose up --build
```

This starts PostgreSQL and the app on port 8000, running database migrations first.

## API overview

- `POST /api/v1/generate-quiz` — generate a quiz (1–250 questions)
- `GET /api/v1/user/{user_id}/profile` / `PATCH /api/v1/user/{user_id}/profile` — user profile
- `DELETE /api/v1/session/{session_id}` — delete a quiz session
- `POST /api/v1/session/{session_id}/attempt` — save a completed attempt
- `GET /api/v1/session/{session_id}/attempts` — attempt history with score comparison
- `POST /auth/forgot-password` / `POST /auth/reset-password` — password reset flow

## Author

Muhammad Saad Jadoon — AI Engineer
