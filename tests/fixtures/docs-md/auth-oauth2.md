# OAuth 2.0 Authentication

## OAuth 2.0

Linear uses OAuth 2.0 for authorization. You can use the following endpoints:

- Authorize: `https://linear.app/oauth/authorize`
- Token: `https://linear.app/oauth/token`

### Scopes

The following scopes are available:

* `read` - Read access to all resources
* `write` - Write access to resources
* `admin` - Full administrative access

### Example

```http
GET /oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT_URI&response_type=code&scope=read,write
```

After authorization, exchange the code for a token at `/oauth/token`.
