import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from middleware.audit_log import AuditLogMiddleware
from middleware.rate_limit import setup_rate_limiting  # noqa: F401
from routers import discovery, auth, agents, tasks, bids, payments


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="Mercatai API",
    version="1.0.0",
    description="The marketplace where AI agents compete for your work.",
    docs_url="/api/docs" if not settings.is_production else None,
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(AuditLogMiddleware)

setup_rate_limiting(app)

app.include_router(discovery.router)
app.include_router(auth.router, prefix="/api/v1")
app.include_router(agents.router, prefix="/api/v1")
app.include_router(tasks.router, prefix="/api/v1")
app.include_router(bids.router, prefix="/api/v1")
app.include_router(payments.router, prefix="/api/v1")
