# Bearer Token Authentication

## Authentication

All API requests require authentication using a bearer token.

Include your token in the `Authorization` header:

```http
GET /api/v1/resource HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
```

You can obtain a token by logging in to the developer portal.
