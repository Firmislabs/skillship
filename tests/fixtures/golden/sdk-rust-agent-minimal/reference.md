# Reference
## Items
<details><summary><code>client.items.<a href="/src/api/resources/items/client.rs">list</a>(cursor: Option&lt;Option&lt;String&gt;&gt;, limit: Option&lt;Option&lt;i64&gt;&gt;) -> Result&lt;ItemsListResponse, ApiError&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns a cursor-paginated page of items.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```rust
use skillship_api::prelude::*;

#[tokio::main]
async fn main() {
    let config = ClientConfig {
        token: Some("<token>".to_string()),
        ..Default::default()
    };
    let client = ApiClient::new(config).expect("Failed to build client");
    client
        .items
        .list(
            &ItemsListQueryRequest {
                ..Default::default()
            },
            None,
        )
        .await;
}
```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**cursor:** `Option<String>` 
    
</dd>
</dl>

<dl>
<dd>

**limit:** `Option<i64>` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.items.<a href="/src/api/resources/items/client.rs">create</a>(request: std::collections::HashMap&lt;String, serde_json::Value&gt;) -> Result&lt;ItemsCreateResponse, ApiError&gt;</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```rust
use skillship_api::prelude::*;

#[tokio::main]
async fn main() {
    let config = ClientConfig {
        token: Some("<token>".to_string()),
        ..Default::default()
    };
    let client = ApiClient::new(config).expect("Failed to build client");
    client
        .items
        .create(
            &HashMap::from([("key".to_string(), serde_json::json!("value"))]),
            None,
        )
        .await;
}
```
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Logs
<details><summary><code>client.logs.<a href="/src/api/resources/logs/client.rs">list</a>(limit: Option&lt;Option&lt;i64&gt;&gt;, offset: Option&lt;Option&lt;i64&gt;&gt;) -> Result&lt;LogsListResponse, ApiError&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns an offset-paginated page of log lines.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```rust
use skillship_api::prelude::*;

#[tokio::main]
async fn main() {
    let config = ClientConfig {
        token: Some("<token>".to_string()),
        ..Default::default()
    };
    let client = ApiClient::new(config).expect("Failed to build client");
    client
        .logs
        .list(
            &LogsListQueryRequest {
                ..Default::default()
            },
            None,
        )
        .await;
}
```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**limit:** `Option<i64>` 
    
</dd>
</dl>

<dl>
<dd>

**offset:** `Option<i64>` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Oauth
<details><summary><code>client.oauth.<a href="/src/api/resources/oauth/client.rs">token</a>() -> Result&lt;OauthTokenResponse, ApiError&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Client-credentials token endpoint. Intentionally authless.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```rust
use skillship_api::prelude::*;

#[tokio::main]
async fn main() {
    let config = ClientConfig {
        token: Some("<token>".to_string()),
        ..Default::default()
    };
    let client = ApiClient::new(config).expect("Failed to build client");
    client.oauth.token(None).await;
}
```
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

