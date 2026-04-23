# POST /v1/resources

Create a new resource.

## Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `name` | body | string | Yes | Name for the new resource |
| `description` | body | string | No | Optional description |
| `tags` | body | array | No | List of tag strings |

## Responses

### 201 Created

```json
{
  "id": "res_xyz789",
  "name": "New Resource",
  "description": null,
  "tags": [],
  "created_at": "2025-01-01T00:00:00Z"
}
```

### 400 Bad Request

```json
{ "error": "validation_error", "fields": { "name": "required" } }
```

### 409 Conflict

```json
{ "error": "conflict", "message": "Resource with this name already exists" }
```
