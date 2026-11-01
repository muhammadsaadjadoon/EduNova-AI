# EduNova-AI

AI-powered learning platform that transforms study material into interactive quizzes using a fine-tuned T5 question-generation model. Built with Python and FastAPI, it follows a structured MCQ generation pipeline to create high-quality questions, with a clean API and Docker-based deployment for scalable, AI-driven learning.

## Overview

AI-powered learning platform that transforms study material into interactive quizzes using a fine-tuned T5 question-generation model. Built with Python and FastAPI, it follows a structured MCQ generation pipeline to create high-quality questions, with a clean API and Docker-based deployment for scalable, AI-driven learning.

## Key Features

| Feature | What it does |
| --- | --- |
| AI Quiz Generation | Generate 1–250 multiple-choice questions from any study text via `POST /api/v1/generate-quiz` |
| Fine-Tuned T5 Engine | A bundled fine-tuned T5 model (`t5_qg_finetuned/`) generates questions, with CPU/CUDA device-aware inference and fallback loading (fine-tuned → local pretrained → Hugging Face → template) |
| Smart Distractors | Noun-phrase answer extraction plus sentence-embedding and WordNet-based distractor generation, with quality scoring |
| Difficulty Modeling | Question difficulty estimation to keep quizzes balanced |
| Quiz Sessions | Create and delete quiz sessions, save completed attempts, and reattempt sessions |
| Attempt History | Per-session attempt history with score comparison to track progress over time |
| User Accounts | Profiles with avatar upload (base64) and email/username/password updates |
| Password Recovery | Token-based forgot/reset password flow |
| Versioned REST API | Clean `/api/v1` endpoints for users, profiles, sessions, and attempts |

## How It Works

1. **Text preparation** — Study text is split into sentences and tagged with POS tags.
2. **Answer extraction** — Key noun phrases are extracted as quiz answers.
3. **Question generation** — The fine-tuned T5 model generates questions from the sentences and answers.
4. **Distractor generation** — Plausible wrong answers are built with sentence embeddings and WordNet.
5. **Quality control** — A quality scorer filters and ranks the generated questions, and a difficulty model grades them.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.11/3.12, FastAPI, Uvicorn, Pydantic v2 |
| AI / ML | PyTorch, Hugging Face Transformers, sentence-transformers, NLTK |
| Database | SQLAlchemy 2 with Alembic migrations — SQLite locally, PostgreSQL in production |
| Auth | Werkzeug password hashing, token-based password reset |
| Frontend | Single-page interface (`index.html`) |
| Deployment | Docker, Docker Compose, Gunicorn with Uvicorn workers, Render-ready (`runtime.txt`) |

## Architecture

| File | Responsibility |
| --- | --- |
| `app.py` | FastAPI application: quiz generation, user and profile management, quiz sessions, attempt tracking, and auth |
| `ml_engine.py` | MCQ generation pipeline: sentence splitting, POS tagging, noun-phrase extraction, T5 question generation, distractor generation, quality scoring |
| `difficulty_model.py` | Question difficulty modeling |
| `db_manage.py` | Database management helpers |
| `alembic/` | Database migrations |
| `t5_qg_finetuned/` | Bundled fine-tuned T5 question-generation model |
| `index.html` | Frontend interface |
| `Dockerfile`, `docker-compose.yml` | Containerized deployment (PostgreSQL database + app, with migrations run on startup) |
| `scripts/`, `assets/` | Supporting files |

## Getting Started

### Prerequisites

- Python 3.11 or 3.12
- pip
- (Optional) Docker and Docker Compose for the containerized setup

### Run Locally

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn app:app --reload
```

The API is served at http://127.0.0.1:8000.

### Run with Docker Compose

Set `POSTGRES_PASSWORD` in a `.env` file (see `.env.example`), then:

```bash
docker compose up --build
```

This starts PostgreSQL and the app on port 8000, running database migrations first.

## API Overview

| Endpoint | Description |
| --- | --- |
| `POST /api/v1/generate-quiz` | Generate a quiz (1–250 questions) |
| `GET /api/v1/user/{user_id}/profile` | Get a user profile |
| `PATCH /api/v1/user/{user_id}/profile` | Update a user profile |
| `DELETE /api/v1/session/{session_id}` | Delete a quiz session |
| `POST /api/v1/session/{session_id}/attempt` | Save a completed attempt |
| `GET /api/v1/session/{session_id}/attempts` | Attempt history with score comparison |
| `POST /auth/forgot-password` | Request a password reset |
| `POST /auth/reset-password` | Reset the password |

## Configuration

Environment-based settings live in a `.env` file — copy `.env.example` to `.env` and fill in the values. No secrets are committed to the repository.

## Author

Muhammad Saad Jadoon — AI Engineer
