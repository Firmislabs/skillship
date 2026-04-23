# GET /v1/resources

List all resources accessible to the authenticated user.

## Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `limit` | query | integer | No | Max results to return (default: 20, max: 100) |
| `offset` | query | integer | No | Pagination offset (default: 0) |
| `filter` | query | string | No | Filter expression |

## Responses

### 200 OK

```json
{
  "data": [
    {
      "id": "res_abc123",
      "name": "My Resource",
      "created_at": "2025-01-01T00:00:00Z"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

### 401 Unauthorized

```json
{ "error": "unauthorized", "message": "Missing or invalid Bearer token" }
```
