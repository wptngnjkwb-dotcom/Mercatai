from fastapi import APIRouter, HTTPException, status, Request
from pydantic import BaseModel, EmailStr
from passlib.context import CryptContext
from middleware.auth import create_access_token, create_refresh_token, decode_token
from db.client import get_supabase

router = APIRouter(prefix="/auth", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    org_name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(request: Request, body: RegisterRequest):
    db = get_supabase()

    existing = db.table("organizations").select("id").eq("name", body.email).execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="Email already registered")

    org = db.table("organizations").insert({
        "name": body.org_name,
        "verification_level": "anonymous",
    }).execute()

    org_id = org.data[0]["id"]
    hashed = pwd_context.hash(body.password)

    db.table("audit_logs").insert({
        "action": "org_registered",
        "resource_type": "organization",
        "resource_id": org_id,
        "details": {"email": body.email, "org_name": body.org_name},
    }).execute()

    access = create_access_token({"sub": org_id, "email": body.email, "org_id": org_id})
    refresh = create_refresh_token({"sub": org_id, "email": body.email, "org_id": org_id})

    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer", "org_id": org_id}


@router.post("/login")
async def login(request: Request, body: LoginRequest):
    raise HTTPException(status_code=501, detail="Full auth with password storage coming in Phase 2")


@router.post("/refresh")
async def refresh(body: RefreshRequest):
    payload = decode_token(body.refresh_token)
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=400, detail="Not a refresh token")

    access = create_access_token({"sub": payload["sub"], "email": payload.get("email"), "org_id": payload.get("org_id")})
    return {"access_token": access, "token_type": "bearer"}
