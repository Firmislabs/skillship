# Reference
## Projects
<details><summary><code>client.projects.<a href="/src/api/resources/projects/client.rs">list</a>(limit: Option&lt;Option&lt;i64&gt;&gt;) -> Result&lt;ProjectList, ApiError&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns every project visible to the caller.
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
        .projects
        .list(
            &ListQueryRequest {
                ..Default::default()
            },
            Some(RequestOptions::new().additional_header("X-Trace-Id", "X-Trace-Id")),
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
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.projects.<a href="/src/api/resources/projects/client.rs">create</a>(request: ProjectInput) -> Result&lt;std::collections::HashMap&lt;String, serde_json::Value&gt;, ApiError&gt;</code></summary>
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
        .projects
        .create(
            &ProjectInput(HashMap::from([(
                "key".to_string(),
                serde_json::json!("value"),
            )])),
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

