# SheetAPI 249

Vercel-hosted Google Sheets to JSON REST API starter.

## Stack
React + Vite, Vercel Node Function, Google Sheets API v4 (read/write scope; users must reconnect Google after scope changes), Upstash Redis.

## Required Vercel environment variables
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REDIRECT_URI (https://YOUR_DOMAIN/api/auth/google/callback)
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- CORS_ORIGINS (your deployment origin)

## Setup
1. In Google Cloud Console create a project and enable Google Sheets API and Google Drive API.
2. Configure OAuth consent screen and create OAuth Client ID (Web application).
3. Add exact redirect URI: https://YOUR_DOMAIN/api/auth/google/callback
4. Create Upstash Redis database and copy REST URL and token.
5. Add environment variables in Vercel, then redeploy.

## Endpoints
- GET /api/health
- GET /api/auth/google
- GET /api/auth/me
- GET /api/sheets (login required)
- GET/POST /api/projects (login required)
- DELETE /api/projects/:id (login required)
- POST /api/projects/:id/refresh (login required)
- GET/POST/PUT/PATCH/DELETE /api/v1/:project/:sheet

Private endpoints require X-API-Key. Data supports search, limit (maximum 1000), and offset. Write operations require project write access enabled and a valid X-API-Key. POST appends rows; PUT replaces a row; PATCH updates provided columns; DELETE removes a row. Row updates/deletes use ?row= (row 1 is the header).

## Important
This starter does not write rows to Google Sheets. Google quotas, Vercel function limits and Redis limits still apply; unlimited traffic cannot be guaranteed. Redis is required in production because Vercel serverless memory is ephemeral.

## Read/write permission upgrade
This release requests the full Google Sheets OAuth scope. Existing users must sign out and connect Google again, then grant the updated permission. Write access is disabled by default per project. Enable it in project Settings; every write request requires the project's X-API-Key, including public-read projects.

## Project controls
- PATCH /api/projects/:id/settings (access, allowWrite, cacheSeconds)
- POST /api/projects/:id/key (regenerate API key; shown once)
- GET /api/projects/:id/analytics
