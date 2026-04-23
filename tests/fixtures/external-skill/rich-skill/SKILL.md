---
name: rich-api-skill
description: A comprehensive skill covering authentication, operations, and error handling for the Rich API.
user-invocable: true
allowed-tools:
  - Bash
---

# Rich API Skill

This skill covers the Rich API — a powerful service for managing resources and workflows.

## Authentication

Use a Bearer token in the Authorization header for all requests:

```bash
curl -H "Authorization: Bearer <your-token>" https://api.rich-example.com/v1/resources
```

Tokens are obtained via OAuth2. Refresh tokens expire after 30 days.

Rate limits apply: 1000 requests per minute per API key. On 429, retry after `X-RateLimit-Reset` seconds.

## Operations

- `GET /v1/resources` — List all resources accessible to the authenticated user
- `POST /v1/resources` — Create a new resource with the given properties
- `GET /v1/resources/{id}` — Retrieve a specific resource by ID
- `PATCH /v1/resources/{id}` — Update an existing resource (partial update)
- `DELETE /v1/resources/{id}` — Delete a resource permanently

## Errors

Standard HTTP status codes apply:

- `400` — Bad request: malformed JSON or missing required fields
- `401` — Unauthorized: missing or invalid Bearer token
- `403` — Forbidden: token lacks required scope
- `404` — Not found: resource does not exist or is not visible to the caller
- `429` — Rate limit exceeded: check `X-RateLimit-Remaining` and `Retry-After` headers
- `500` — Internal server error: retry with exponential backoff

```bash
# Check rate limit headers
curl -I -H "Authorization: Bearer <token>" https://api.rich-example.com/v1/resources
```
